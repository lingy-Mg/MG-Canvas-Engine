#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod desktop_queue;

#[cfg(windows)]
mod workbench {
    use super::desktop_queue::{Job, Queue};
    use mg_canvas_desktop::desktop_control::{pipe, read_project, Failure, Request};
    use serde_json::{json, Value};
    use std::{io, sync::Arc, time::Duration};
    use tauri::{AppHandle, Manager, State, Webview};
    use tokio::{
        io::AsyncReadExt, net::windows::named_pipe::NamedPipeServer, task::JoinSet, time::timeout,
    };
    use windows_sys::Win32::{
        Foundation::ERROR_ACCESS_DENIED,
        UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR},
    };

    fn workbench_page(url: &tauri::Url) -> bool {
        matches!(
            (url.scheme(), url.host_str()),
            ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
        ) && url.port().is_none()
            && matches!(url.path(), "/" | "/index.html")
    }

    fn authorize(webview: &Webview) -> Result<(), String> {
        if webview.label() == "main" && webview.url().is_ok_and(|url| workbench_page(&url)) {
            Ok(())
        } else {
            Err("This command is restricted to the local MG Canvas workbench".into())
        }
    }

    #[tauri::command]
    async fn desktop_next(
        webview: Webview,
        queue: State<'_, Arc<Queue>>,
    ) -> Result<Option<Job>, String> {
        authorize(&webview)?;
        Ok(queue.next().await)
    }

    #[tauri::command]
    async fn desktop_complete(
        webview: Webview,
        queue: State<'_, Arc<Queue>>,
        id: String,
        result: Value,
    ) -> Result<(), String> {
        authorize(&webview)?;
        queue.complete(&id, result).map_err(str::to_owned)
    }

    async fn dispatch(app: &AppHandle, queue: &Queue, request: Request) -> Value {
        let Some(window) = app.get_webview_window("main") else {
            return Failure::new("NO_WINDOW", "The MG Canvas workbench is closed").result();
        };
        match request {
            Request::Focus => {
                let _ = window.unminimize();
                let _ = window.set_focus();
                json!({"ok":true})
            }
            Request::Tools => {
                queue
                    .submit("tools", json!({}), pipe::COMMAND_TIMEOUT)
                    .await
            }
            Request::Call { name, arguments } => {
                if !name.starts_with("canvas_") || name.len() > 128 || !arguments.is_object() {
                    return Failure::new(
                        "INVALID",
                        "Expected a canvas tool name and an arguments object",
                    )
                    .result();
                }
                queue
                    .submit(
                        "call",
                        json!({ "name":name, "arguments":arguments }),
                        pipe::COMMAND_TIMEOUT,
                    )
                    .await
            }
            Request::Open { path } => {
                if !path.is_absolute() {
                    return Failure::new("INVALID", "Open requires an absolute project path")
                        .result();
                }
                let Some(file_name) = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
                else {
                    return Failure::new("INVALID", "Expected a Unicode project filename").result();
                };
                match timeout(
                    pipe::TRANSFER_TIMEOUT,
                    tokio::task::spawn_blocking(move || read_project(&path)),
                )
                .await
                {
                    Ok(Ok(Ok(encoded))) => {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                        queue
                            .submit(
                                "open",
                                json!({"fileName":file_name,"encoded":encoded}),
                                pipe::OPEN_TIMEOUT,
                            )
                            .await
                    }
                    Ok(Ok(Err(failure))) => failure.result(),
                    Ok(Err(error)) => Failure::new("IO", error.to_string()).result(),
                    Err(_) => Failure::new("IO", "Timed out reading the project file").result(),
                }
            }
            Request::Snapshot => {
                queue
                    .submit("snapshot", json!({}), pipe::COMMAND_TIMEOUT)
                    .await
            }
        }
    }

    async fn handle(mut client: NamedPipeServer, app: AppHandle, queue: Arc<Queue>) {
        let response = match timeout(pipe::TRANSFER_TIMEOUT, pipe::read_request(&mut client)).await
        {
            Ok(Ok(request)) => dispatch(&app, &queue, request).await,
            Ok(Err(error)) => Failure::new("INVALID", error.to_string()).result(),
            Err(_) => return,
        };
        if let Ok(Ok(())) = timeout(
            pipe::TRANSFER_TIMEOUT,
            pipe::write_frame(&mut client, &response),
        )
        .await
        {
            let _ = timeout(Duration::from_secs(2), client.read_u8()).await;
        }
    }

    async fn listen(
        endpoint: pipe::Endpoint,
        mut server: NamedPipeServer,
        app: AppHandle,
        queue: Arc<Queue>,
    ) -> io::Result<()> {
        let mut tasks = JoinSet::new();
        loop {
            while tasks.try_join_next().is_some() {}
            if tasks.len() >= pipe::CAPACITY {
                let _ = tasks.join_next().await;
            }
            server.connect().await?;
            let connected = std::mem::replace(&mut server, endpoint.server(false)?);
            tasks.spawn(handle(connected, app.clone(), queue.clone()));
        }
    }

    fn initial_request() -> Result<Request, Failure> {
        let mut args = std::env::args_os().skip(1);
        let Some(path) = args.next() else {
            return Ok(Request::Focus);
        };
        if args.next().is_some() {
            return Err(Failure::new("INVALID", "Expected one .mgcanvas file"));
        }
        let path = std::path::absolute(path).map_err(Failure::io)?;
        if path.to_str().is_none() {
            return Err(Failure::new("INVALID", "Expected a Unicode project path"));
        }
        Ok(Request::Open { path })
    }

    pub fn error_dialog(message: &str) {
        let title = "MG Canvas".encode_utf16().chain([0]).collect::<Vec<_>>();
        let message = message.encode_utf16().chain([0]).collect::<Vec<_>>();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_ICONERROR,
            )
        };
    }

    fn show_failure(result: &Value) {
        if result["ok"] != true && result["code"] != "CANCELLED" {
            error_dialog(
                result["message"]
                    .as_str()
                    .or_else(|| result["error"]["message"].as_str())
                    .unwrap_or("MG Canvas could not open the project."),
            );
        }
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let request = initial_request()?;
        let runtime = pipe::runtime()?;
        let endpoint = pipe::Endpoint::current()?;
        let mut claim_retried = false;
        let server = loop {
            let server = {
                let _context = runtime.enter();
                endpoint.server(true)
            };
            match server {
                Ok(server) => break server,
                Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                    match runtime.block_on(endpoint.exchange(&request)) {
                        Ok(result) => {
                            show_failure(&result);
                            return Ok(());
                        }
                        // The primary can close between our claim and the connection attempt.
                        Err(failure) if failure.code == "NO_WINDOW" && !claim_retried => {
                            claim_retried = true;
                        }
                        Err(failure) => return Err(failure.into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        };

        let queue = Arc::new(Queue::default());
        let (start_server, startup) = std::sync::mpsc::sync_channel::<AppHandle>(1);
        let (stop_server, shutdown) = tokio::sync::oneshot::channel();
        let listen_queue = queue.clone();
        let worker = std::thread::spawn(move || {
            if let Ok(app) = startup.recv() {
                runtime.block_on(async move {
                    let initial_app = app.clone();
                    let initial_queue = listen_queue.clone();
                    tokio::spawn(async move {
                        if matches!(request, Request::Open { .. }) {
                            let result = dispatch(&initial_app, &initial_queue, request).await;
                            if result["ok"] != true && result["code"] != "CANCELLED" {
                                let _ = std::thread::spawn(move || show_failure(&result));
                            }
                        }
                    });
                    tokio::spawn(async move {
                        if let Err(error) = listen(endpoint, server, app, listen_queue).await {
                            let _ = std::thread::spawn(move || error_dialog(&error.to_string()));
                        }
                    });
                    let _ = shutdown.await;
                });
            }
            runtime.shutdown_background();
        });

        let result = tauri::Builder::default()
            .manage(queue)
            .on_page_load(|webview, payload| {
                if webview.label() == "main"
                    && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
                {
                    webview.state::<Arc<Queue>>().reset_page();
                }
            })
            .invoke_handler(tauri::generate_handler![desktop_next, desktop_complete])
            .setup(move |app| {
                start_server.send(app.handle().clone())?;
                Ok(())
            })
            .run(tauri::generate_context!());
        let _ = stop_server.send(());
        let _ = worker.join();
        result.map_err(Into::into)
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = workbench::run() {
        workbench::error_dialog(&error.to_string());
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("could not start MG Canvas");
}
