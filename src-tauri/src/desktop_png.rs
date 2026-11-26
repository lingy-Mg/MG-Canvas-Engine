use serde_json::Value;
use std::{
    fs,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    http::{header, Method, Response, StatusCode},
    webview::{NewWindowResponse, PlatformWebview},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

const SCHEME: &str = "mgcanvas-render";
const PAGE: &str = "/png-render.html";
const SCRIPT: &str = "/app/desktop-png.js";
const WEBVIEW: &str = "png-render";
const CSP: &str = "default-src 'none'; script-src 'self'; img-src blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_METADATA_BYTES: usize = 16 * 1024;
// A maximum-area RGBA canvas contains 32 MiB before PNG encoding.
const MAX_PNG_BYTES: usize = 34 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

type RenderResult = Result<(Vec<u8>, Value), String>;

/// Run one offline render on the Windows CLI's main thread.
pub fn render(project: String, options: Value) -> Result<(Vec<u8>, Value), String> {
    let profile = tempfile::Builder::new()
        .prefix("mgcanvas-webview-")
        .tempdir()
        .map_err(dependency_error)?;
    let data_directory = profile.path().to_path_buf();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let packaged = |path: &str| {
        context
            .assets()
            .get(&path.into())
            .map(|bytes| bytes.into_owned())
            .ok_or_else(|| {
                format!("RENDER_DEPENDENCY: The packaged PNG frontend is missing {path}")
            })
    };
    let page = packaged(PAGE)?;
    let script = packaged(SCRIPT)?;

    let project = Mutex::new(Some(project.into_bytes()));
    let options = options.to_string().into_bytes();
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let protocol_result = result_tx.clone();
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol(SCHEME, move |ctx, request| {
            let url = request.uri();
            if ctx.webview_label() != WEBVIEW
                || url.scheme_str() != Some(SCHEME)
                || url.authority().map(|authority| authority.as_str()) != Some("localhost")
                || url.query().is_some()
            {
                return missing();
            }
            match (request.method(), url.path()) {
                (&Method::GET, PAGE) => {
                    response(StatusCode::OK, "text/html; charset=utf-8", page.clone())
                }
                (&Method::GET, SCRIPT) => response(
                    StatusCode::OK,
                    "text/javascript; charset=utf-8",
                    script.clone(),
                ),
                (&Method::GET, "/project") => match project.lock().unwrap().take() {
                    Some(bytes) => {
                        response(StatusCode::OK, "application/json; charset=utf-8", bytes)
                    }
                    None => missing(),
                },
                (&Method::GET, "/options") => response(
                    StatusCode::OK,
                    "application/json; charset=utf-8",
                    options.clone(),
                ),
                (&Method::POST, "/result") => {
                    complete(
                        ctx.app_handle(),
                        &protocol_result,
                        decode_result(request.into_body()),
                    );
                    response(StatusCode::NO_CONTENT, "text/plain", Vec::new())
                }
                _ => missing(),
            }
        })
        .build(context)
        .map_err(dependency_error)?;

    let handle = app.handle().clone();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let timeout_result = result_tx.clone();
    let watchdog = thread::Builder::new()
        .name("mgcanvas-png-timeout".into())
        .spawn(move || {
            if stop_rx.recv_timeout(TIMEOUT) == Err(mpsc::RecvTimeoutError::Timeout) {
                complete(
                    &handle,
                    &timeout_result,
                    Err("RENDER_TIMEOUT: The WebView2 PNG renderer did not finish".into()),
                );
            }
        })
        .map_err(dependency_error)?;

    let browser_process = Arc::new(Mutex::new(None));
    let runtime_process = browser_process.clone();
    app.run_return(move |app, event| match event {
        RunEvent::Ready => {
            let page = format!("{SCHEME}://localhost{PAGE}").parse().unwrap();
            let browser_page = format!("https://{SCHEME}.localhost{PAGE}");
            let window = WebviewWindowBuilder::new(app, WEBVIEW, WebviewUrl::CustomProtocol(page))
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .disable_drag_drop_handler()
                .devtools(false)
                .incognito(true)
                .data_directory(data_directory.clone())
                .use_https_scheme(true)
                .on_navigation(move |url| url.as_str() == browser_page)
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build();
            match window {
                Ok(window) => {
                    let runtime_process = runtime_process.clone();
                    let _ = window.with_webview(move |webview| {
                        *runtime_process.lock().unwrap() = open_browser_process(webview);
                    });
                }
                Err(error) => complete(app, &result_tx, Err(dependency_error(error))),
            }
        }
        RunEvent::ExitRequested {
            code: Some(_), api, ..
        } => {
            // Destroy the controller while its UI thread is still pumping messages.
            if app
                .get_webview_window(WEBVIEW)
                .is_some_and(|window| window.destroy().is_ok())
            {
                api.prevent_exit();
            }
        }
        _ => {}
    });
    drop(stop_tx);
    let _ = watchdog.join();
    if let Some(process) = browser_process.lock().unwrap().take() {
        // Wait for the isolated browser to release the files in its temporary profile.
        unsafe { WaitForSingleObject(process.as_raw_handle(), 2_000) };
    }
    let profile_path = profile.path().to_path_buf();
    if profile.close().is_err() {
        // WebView2's browser subprocess can hold profile files briefly after its window closes.
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(50));
            match fs::remove_dir_all(&profile_path) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) => {}
            }
        }
    }
    result_rx.try_recv().unwrap_or_else(|_| {
        Err("RENDER_FAILED: The PNG webview closed before returning a result".into())
    })
}

fn response(status: StatusCode, mime: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", CSP)
        .body(bytes)
        .expect("valid PNG renderer response headers")
}

fn missing() -> Response<Vec<u8>> {
    response(StatusCode::NOT_FOUND, "text/plain", Vec::new())
}

fn complete(app: &AppHandle, output: &mpsc::SyncSender<RenderResult>, result: RenderResult) {
    if output.try_send(result).is_ok() {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || handle.exit(0));
    }
}

fn open_browser_process(webview: PlatformWebview) -> Option<OwnedHandle> {
    // Capture a waitable handle while the WebView is alive, before Windows can reuse its PID.
    unsafe {
        let mut pid = 0;
        webview
            .controller()
            .CoreWebView2()
            .ok()?
            .BrowserProcessId(&mut pid)
            .ok()?;
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        (!handle.is_null()).then(|| OwnedHandle::from_raw_handle(handle))
    }
}

fn dependency_error(error: impl std::fmt::Display) -> String {
    format!("RENDER_DEPENDENCY: Unable to start the WebView2 PNG renderer: {error}")
}

fn decode_result(mut body: Vec<u8>) -> RenderResult {
    let invalid = || "RENDER_FAILED: Invalid result from the PNG renderer".to_owned();
    let delimiter = body
        .iter()
        .take(MAX_METADATA_BYTES)
        .position(|&byte| byte == b'\n')
        .ok_or_else(invalid)?;
    let mut metadata: Value = serde_json::from_slice(&body[..delimiter]).map_err(|_| invalid())?;
    let fields = metadata.as_object_mut().ok_or_else(invalid)?;
    match fields.remove("ok").and_then(|ok| ok.as_bool()) {
        Some(false) if delimiter + 1 == body.len() => {
            let code = match fields.get("code").and_then(Value::as_str) {
                Some(code @ ("INVALID" | "NOT_FOUND" | "TOO_LARGE")) => code,
                _ => "RENDER_FAILED",
            };
            let message = fields
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            Err(format!("{code}: {message}"))
        }
        Some(true) => {
            let png = &body[delimiter + 1..];
            if !(33..=MAX_PNG_BYTES).contains(&png.len())
                || !png.starts_with(PNG_SIGNATURE)
                || png[8..16] != *b"\0\0\0\rIHDR"
            {
                return Err(invalid());
            }
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
            if !(1..=4096).contains(&width)
                || !(1..=4096).contains(&height)
                || width * height > 8_388_608
                || fields.get("width").and_then(Value::as_u64) != Some(width.into())
                || fields.get("height").and_then(Value::as_u64) != Some(height.into())
            {
                return Err(invalid());
            }
            body.drain(..=delimiter);
            Ok((body, metadata))
        }
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(width: u32, height: u32, png: &[u8]) -> Vec<u8> {
        [
            format!("{{\"ok\":true,\"width\":{width},\"height\":{height}}}\n").as_bytes(),
            png,
        ]
        .concat()
    }

    #[test]
    fn result_requires_png_header_and_matching_bounded_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend([0, 0, 1, 0, 0, 0, 0, 192]);
        png.resize(33, 0);
        let (bytes, meta) = decode_result(response(256, 192, &png)).unwrap();
        assert_eq!(bytes, png);
        assert_eq!(meta, serde_json::json!({"width":256,"height":192}));
        assert!(decode_result(response(255, 192, &png)).is_err());
        assert!(decode_result(response(256, 192, &png[..32])).is_err());
        png[16..20].copy_from_slice(&4097_u32.to_be_bytes());
        assert!(decode_result(response(4097, 192, &png)).is_err());
    }

    #[test]
    fn result_preserves_expected_renderer_errors() {
        let body = b"{\"ok\":false,\"code\":\"NOT_FOUND\",\"message\":\"Unknown object ID\"}\n";
        assert_eq!(
            decode_result(body.to_vec()).unwrap_err(),
            "NOT_FOUND: Unknown object ID"
        );
        assert!(decode_result(body[..body.len() - 1].to_vec()).is_err());
    }
}
