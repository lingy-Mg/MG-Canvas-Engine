#[cfg(windows)]
#[path = "../desktop_mcp.rs"]
mod desktop_mcp;
#[cfg(windows)]
#[path = "../desktop_png.rs"]
mod desktop_png;

#[cfg(windows)]
mod cli {
    use super::{desktop_mcp, desktop_png};
    use mg_canvas_desktop::desktop_control::{
        open_input, pipe, read_project, read_utf8, write_new, Failure, Request, ARGUMENT_LIMIT,
    };
    use serde_json::{json, Map, Value};
    use sha2::{Digest, Sha256};
    use std::{
        collections::BTreeMap,
        ffi::{OsStr, OsString},
        fmt::Write as _,
        io::{self, Write},
        path::{Path, PathBuf},
    };

    type Result<T> = std::result::Result<T, Failure>;

    const USAGE: &[&str] = &[
        "mgcanvas tools",
        "mgcanvas read [--args-file PATH | --stdin]",
        "mgcanvas call canvas_TOOL [--args-file PATH | --stdin]",
        "mgcanvas open PATH",
        "mgcanvas export --out PATH",
        "mgcanvas png (--file PATH | --active) --out PATH [--id ID] [--scale auto|NUMBER]",
        "mgcanvas mcp [--stdio]",
    ];

    fn invalid(message: impl Into<String>) -> Failure {
        Failure::new("INVALID", message)
    }

    enum Command {
        Help,
        Version,
        Workbench(Request),
        Export(PathBuf),
        Png {
            input: Option<PathBuf>,
            output: PathBuf,
            options: Value,
        },
    }

    fn required_path(options: &mut BTreeMap<String, OsString>, flag: &str) -> Result<PathBuf> {
        options
            .remove(flag)
            .map(PathBuf::from)
            .ok_or_else(|| invalid(format!("Missing {flag} PATH")))
    }

    fn positional(args: &mut impl Iterator<Item = OsString>, label: &str) -> Result<OsString> {
        args.next()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(format!("Missing {label}")))
    }

    fn flags(
        args: impl Iterator<Item = OsString>,
        values: &[&str],
        switches: &[&str],
    ) -> Result<BTreeMap<String, OsString>> {
        let mut options = BTreeMap::new();
        let mut args = args;
        while let Some(arg) = args.next() {
            let flag = arg
                .to_str()
                .ok_or_else(|| invalid("Expected an option name"))?;
            let value = if values.contains(&flag) {
                positional(&mut args, flag)?
            } else if switches.contains(&flag) {
                OsString::new()
            } else {
                return Err(invalid(format!("Unknown option {flag}")));
            };
            if options.insert(flag.to_owned(), value).is_some() {
                return Err(invalid(format!("Duplicate option {flag}")));
            }
        }
        Ok(options)
    }

    fn tool_args(options: BTreeMap<String, OsString>) -> Result<Value> {
        let input = match (options.get("--args-file"), options.contains_key("--stdin")) {
            (Some(_), true) => return Err(invalid("Use --args-file PATH or --stdin")),
            (None, true) => read_utf8(io::stdin().lock(), ARGUMENT_LIMIT)?,
            (Some(path), false) if path == "-" => read_utf8(io::stdin().lock(), ARGUMENT_LIMIT)?,
            (Some(path), false) => read_utf8(open_input(Path::new(path))?, ARGUMENT_LIMIT)?,
            (None, false) => return Ok(json!({})),
        };
        let args: Value =
            serde_json::from_str(&input).map_err(|error| invalid(error.to_string()))?;
        if !args.is_object() {
            return Err(invalid("Tool arguments must be a JSON object"));
        }
        Ok(args)
    }

    fn absolute(path: impl AsRef<Path>) -> Result<PathBuf> {
        let path = std::path::absolute(path).map_err(Failure::io)?;
        if path.to_str().is_none() {
            return Err(invalid("Expected a Unicode file path"));
        }
        Ok(path)
    }

    fn parse(mut args: impl Iterator<Item = OsString>) -> Result<Command> {
        let command = args.next().unwrap_or_else(|| OsString::from("help"));
        let command = command
            .to_str()
            .ok_or_else(|| invalid("Expected a command name"))?;
        if matches!(
            command,
            "help" | "--help" | "-h" | "--version" | "tools" | "capabilities" | "open"
        ) {
            let parsed = match command {
                "help" | "--help" | "-h" => Command::Help,
                "--version" => Command::Version,
                "tools" | "capabilities" => Command::Workbench(Request::Tools),
                "open" => Command::Workbench(Request::Open {
                    path: absolute(positional(&mut args, "PATH")?)?,
                }),
                _ => unreachable!(),
            };
            if args.next().is_some() {
                return Err(invalid(format!("Unexpected extra arguments for {command}")));
            }
            return Ok(parsed);
        }

        match command {
            "read" | "status" | "call" => {
                let name = if command == "call" {
                    let name = positional(&mut args, "canvas_TOOL")?;
                    let name = name
                        .into_string()
                        .map_err(|_| invalid("Expected a tool name"))?;
                    if !name.starts_with("canvas_") || name.len() > 128 {
                        return Err(invalid(
                            "Expected a canvas tool name. Use mgcanvas tools to discover tools",
                        ));
                    }
                    name
                } else {
                    String::from("canvas_read")
                };
                let options = flags(args, &["--args-file"], &["--stdin"])?;
                Ok(Command::Workbench(Request::Call {
                    name,
                    arguments: tool_args(options)?,
                }))
            }
            "export" => {
                let mut options = flags(args, &["--out"], &[])?;
                Ok(Command::Export(absolute(required_path(
                    &mut options,
                    "--out",
                )?)?))
            }
            "png" => {
                let mut flags =
                    flags(args, &["--file", "--out", "--id", "--scale"], &["--active"])?;
                let input = match (flags.remove("--file"), flags.contains_key("--active")) {
                    (Some(path), false) => Some(absolute(path)?),
                    (None, true) => None,
                    _ => return Err(invalid("Use exactly one of --file PATH or --active")),
                };
                let output = absolute(required_path(&mut flags, "--out")?)?;
                let mut options = Map::new();
                if let Some(id) = flags.get("--id") {
                    options.insert(
                        "id".into(),
                        json!(id
                            .to_str()
                            .ok_or_else(|| invalid("Expected a Unicode object ID"))?),
                    );
                }
                if let Some(scale) = flags
                    .get("--scale")
                    .filter(|scale| *scale != OsStr::new("auto"))
                {
                    let scale = scale
                        .to_str()
                        .and_then(|value| value.parse::<f64>().ok())
                        .filter(|value| (0.05..=8.0).contains(value))
                        .ok_or_else(|| invalid("Scale must be auto or a number from 0.05 to 8"))?;
                    options.insert("scale".into(), json!(scale));
                }
                Ok(Command::Png {
                    input,
                    output,
                    options: Value::Object(options),
                })
            }
            _ => Err(invalid(format!(
                "Unknown command {command}. See mgcanvas --help"
            ))),
        }
    }

    fn exchange(request: Request) -> Result<Value> {
        let endpoint = pipe::Endpoint::current().map_err(Failure::io)?;
        pipe::runtime()
            .map_err(Failure::io)?
            .block_on(endpoint.exchange(&request))
    }

    fn encoded(snapshot: &mut Value) -> Result<String> {
        match snapshot
            .as_object_mut()
            .and_then(|object| object.remove("encoded"))
        {
            Some(Value::String(encoded)) => Ok(encoded),
            _ => Err(Failure::new(
                "IO",
                "The workbench did not return an encoded project",
            )),
        }
    }

    fn output_metadata(path: &Path, bytes: &[u8]) -> Result<Map<String, Value>> {
        write_new(path, bytes)?;
        Ok(Map::from_iter([
            ("ok".into(), json!(true)),
            ("path".into(), json!(path)),
            ("bytes".into(), json!(bytes.len())),
            (
                "sha256".into(),
                json!(format!("{:x}", Sha256::digest(bytes))),
            ),
        ]))
    }

    fn add_snapshot_metadata(output: &mut Map<String, Value>, snapshot: &Value) {
        for key in ["revision", "fileName"] {
            if let Some(field) = snapshot.get(key) {
                output.insert(key.into(), field.clone());
            }
        }
    }

    fn execute(command: Command) -> Result<Value> {
        match command {
            Command::Help => Ok(
                json!({"ok":true,"usage":USAGE,"target":"active Windows workbench","arguments":"One UTF-8 JSON object. Omitted arguments default to {}."}),
            ),
            Command::Version => Ok(json!({"ok":true,"version":env!("CARGO_PKG_VERSION")})),
            Command::Workbench(request) => exchange(request),
            Command::Export(path) => {
                let mut snapshot = exchange(Request::Snapshot)?;
                if snapshot["ok"] != true {
                    return Ok(snapshot);
                }
                let project = encoded(&mut snapshot)?;
                let mut output = output_metadata(&path, project.as_bytes())?;
                add_snapshot_metadata(&mut output, &snapshot);
                Ok(Value::Object(output))
            }
            Command::Png {
                input,
                output,
                options,
            } => {
                let (project, snapshot) = if let Some(path) = input {
                    (read_project(&path)?, Value::Null)
                } else {
                    let mut snapshot = exchange(Request::Snapshot)?;
                    if snapshot["ok"] != true {
                        return Ok(snapshot);
                    }
                    (encoded(&mut snapshot)?, snapshot)
                };
                // WebView2/COM rendering owns the console process's main thread.
                let (bytes, metadata) =
                    desktop_png::render(project, options).map_err(render_failure)?;
                let mut metadata = metadata.as_object().cloned().ok_or_else(|| {
                    Failure::new("RENDER_FAILED", "The renderer returned invalid metadata")
                })?;
                metadata.extend(output_metadata(&output, &bytes)?);
                add_snapshot_metadata(&mut metadata, &snapshot);
                Ok(Value::Object(metadata))
            }
        }
    }

    fn render_failure(error: String) -> Failure {
        if let Some((kind, message)) = error.split_once(": ") {
            let code = match kind {
                "INVALID" => "INVALID",
                "NOT_FOUND" => "NOT_FOUND",
                "TOO_LARGE" => "TOO_LARGE",
                "RENDER_DEPENDENCY" => "RENDER_DEPENDENCY",
                "RENDER_TIMEOUT" => "RENDER_TIMEOUT",
                _ => "RENDER_FAILED",
            };
            return Failure::new(code, message);
        }
        Failure::new("RENDER_FAILED", error)
    }

    fn exit_code(result: &Value) -> i32 {
        if result["ok"] == true {
            return 0;
        }
        match result["code"]
            .as_str()
            .or_else(|| result["error"]["code"].as_str())
            .unwrap_or_default()
        {
            "UNKNOWN_OUTCOME" => 5,
            "IO" | "NO_WINDOW" | "NOT_READY" | "ACCESS_DENIED" | "RENDER_FAILED"
            | "RENDER_DEPENDENCY" | "RENDER_TIMEOUT" => 4,
            "BUSY" | "STALE" | "ID_CONFLICT" | "EXISTS" | "CANCELLED" => 3,
            _ => 2,
        }
    }

    // ASCII JSON survives both Windows PowerShell's OEM decoding and UTF-8 clients.
    fn json_line(value: &Value) -> String {
        let encoded = value.to_string();
        let mut line = String::with_capacity(encoded.len() + 1);
        for character in encoded.chars() {
            if character.is_ascii() {
                line.push(character);
            } else {
                for unit in character.encode_utf16(&mut [0; 2]) {
                    write!(line, "\\u{unit:04x}").unwrap();
                }
            }
        }
        line.push('\n');
        line
    }

    pub fn run() -> i32 {
        let mut args = std::env::args_os().skip(1).peekable();
        let result = if args.peek().is_some_and(|argument| argument == "mcp") {
            args.next();
            match (args.next(), args.next()) {
                (None, None) => return run_mcp(),
                (Some(argument), None) if argument == "--stdio" => return run_mcp(),
                _ => invalid("Usage: mgcanvas mcp [--stdio]").result(),
            }
        } else {
            parse(args)
                .and_then(execute)
                .unwrap_or_else(|failure| failure.result())
        };
        if io::stdout()
            .lock()
            .write_all(json_line(&result).as_bytes())
            .is_err()
        {
            return 4;
        }
        exit_code(&result)
    }

    fn run_mcp() -> i32 {
        if let Err(error) = desktop_mcp::serve(exchange) {
            eprintln!("mgcanvas mcp: {error}");
            return 4;
        }
        0
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn png_validates_input_and_scale() {
            let parse_png = |args: &str| parse(args.split_whitespace().map(OsString::from));
            let Command::Png { options, input, .. } =
                parse_png("png --active --out result.png --scale auto")
                    .unwrap_or_else(|error| panic!("{error}"))
            else {
                panic!("Expected PNG command")
            };
            assert!(input.is_none());
            assert_eq!(options, json!({}));
            assert!(parse_png("png --active --file board.mgcanvas --out result.png").is_err());
            assert!(parse_png("png --active --out result.png --scale NaN").is_err());
            assert!(
                parse_png("png --file board.mgcanvas --out result.png --scale 2 --id 节点").is_ok()
            );
        }

        #[test]
        fn stdout_escapes_non_ascii_without_losing_unicode() {
            let message = json!({"text":"项目信息📎\n"});
            let line = json_line(&message);
            assert!(line.is_ascii());
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), message);
        }
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(cli::run());
}

#[cfg(not(windows))]
fn main() {
    println!(
        r#"{{"ok":false,"code":"UNSUPPORTED","message":"The desktop CLI is available on Windows."}}"#
    );
    std::process::exit(4);
}
