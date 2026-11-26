use mg_canvas_desktop::desktop_control::{Failure, Request, ARGUMENT_LIMIT};
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};

const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_LINE: usize = ARGUMENT_LIMIT * 2;

#[derive(Default, PartialEq, Eq)]
enum State {
    #[default]
    New,
    Initializing,
    Ready,
}

fn request_id(id: &Value) -> bool {
    id.is_string()
        || id
            .as_f64()
            .is_some_and(|number| number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
}

fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn bridge_error(id: &Value, code: &str, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{
        "code":-32000,"message":message,"data":{"code":code}
    }})
}

fn handle(
    state: &mut State,
    message: Value,
    call: &mut impl FnMut(Request) -> Result<Value, Failure>,
) -> Option<Value> {
    let id = message.get("id");
    let Some(method) = message["method"]
        .as_str()
        .filter(|_| message["jsonrpc"] == "2.0" && id.is_none_or(request_id))
    else {
        return Some(rpc_error(
            id.filter(|id| request_id(id)).unwrap_or(&Value::Null),
            -32600,
            "Invalid request",
        ));
    };
    let Some(id) = id else {
        if method == "notifications/initialized" && *state == State::Initializing {
            *state = State::Ready;
        }
        return None;
    };
    let empty = json!({});
    let params = message.get("params").unwrap_or(&empty);
    if !params.is_object() {
        return Some(rpc_error(id, -32602, "Expected an object for params"));
    }

    Some(match method {
        "initialize" => {
            if *state != State::New {
                return Some(rpc_error(id, -32600, "The server has already initialized"));
            }
            let Some(version) = params["protocolVersion"].as_str().filter(|_| {
                params["capabilities"].is_object()
                    && params["clientInfo"]["name"].is_string()
                    && params["clientInfo"]["version"].is_string()
            }) else {
                return Some(rpc_error(
                    id,
                    -32602,
                    "Expected protocolVersion, capabilities and clientInfo",
                ));
            };
            *state = State::Initializing;
            let version = if VERSIONS.contains(&version) {
                version
            } else {
                VERSIONS[0]
            };
            rpc_result(
                id,
                json!({
                    "protocolVersion":version,
                    "capabilities":{"tools":{}},
                    "serverInfo":{"name":"mgcanvas","version":env!("CARGO_PKG_VERSION")}
                }),
            )
        }
        "ping" => rpc_result(id, empty),
        _ if *state != State::Ready => rpc_error(id, -32000, "Complete MCP initialization first"),
        "tools/list" if params.get("cursor").is_none_or(Value::is_string) => {
            match call(Request::Tools) {
                Ok(reply) if reply["ok"] == true && reply["tools"].is_array() => {
                    rpc_result(id, json!({"tools":reply["tools"]}))
                }
                Ok(reply) if reply["ok"] == false => bridge_error(
                    id,
                    reply["code"].as_str().unwrap_or("IO"),
                    reply["message"]
                        .as_str()
                        .unwrap_or("Could not read workbench tools"),
                ),
                Ok(_) => rpc_error(id, -32603, "The workbench returned an invalid tool list"),
                Err(error) => bridge_error(id, error.code, &error.message),
            }
        }
        "tools/call" => {
            let Some(name) = params["name"]
                .as_str()
                .filter(|name| name.starts_with("canvas_") && name.len() <= 128)
            else {
                return Some(rpc_error(id, -32602, "Expected a canvas tool name"));
            };
            let arguments = params.get("arguments").unwrap_or(&empty);
            if !arguments.is_object() {
                return Some(rpc_error(id, -32602, "Expected an arguments object"));
            }
            match call(Request::Call {
                name: name.to_owned(),
                arguments: arguments.clone(),
            }) {
                Ok(reply) if reply["ok"].is_boolean() => rpc_result(
                    id,
                    json!({
                        "content":[{"type":"text","text":reply.to_string()}],
                        "structuredContent":reply,
                        "isError":reply["ok"] == false
                    }),
                ),
                Ok(_) => rpc_error(id, -32603, "The workbench returned an invalid tool result"),
                Err(error) => bridge_error(id, error.code, &error.message),
            }
        }
        "tools/list" => rpc_error(id, -32602, "Expected a string cursor"),
        _ => rpc_error(id, -32601, "Method not found"),
    })
}

fn serve_stdio(
    mut input: impl BufRead,
    mut output: impl Write,
    mut call: impl FnMut(Request) -> Result<Value, Failure>,
) -> io::Result<()> {
    let mut state = State::default();
    let mut line = Vec::new();
    loop {
        line.clear();
        let length = input
            .by_ref()
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if length == 0 {
            return Ok(());
        }
        let response = if length > MAX_LINE {
            if !line.ends_with(b"\n") {
                input.skip_until(b'\n')?;
            }
            Some(rpc_error(&Value::Null, -32700, "MCP message exceeds 2 MiB"))
        } else if line.iter().all(u8::is_ascii_whitespace) {
            None
        } else {
            match serde_json::from_slice(&line) {
                Ok(message) => handle(&mut state, message, &mut call),
                Err(_) => Some(rpc_error(&Value::Null, -32700, "Invalid JSON")),
            }
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut output, &response).map_err(io::Error::from)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
}

pub fn serve(call: impl FnMut(Request) -> Result<Value, Failure>) -> io::Result<()> {
    serve_stdio(io::stdin().lock(), io::stdout().lock(), call)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INITIALIZE: &str = concat!(
        r#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#,
        "\n"
    );
    const INITIALIZED: &str = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";
    const TOOLS: &str = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n";

    fn run(input: &str, call: impl FnMut(Request) -> Result<Value, Failure>) -> Vec<Value> {
        let mut output = Vec::new();
        serve_stdio(input.as_bytes(), &mut output, call).unwrap();
        std::str::from_utf8(&output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn negotiates_and_only_dispatches_tools_after_initialized() {
        let input = format!(
            "{INITIALIZE}{TOOLS}{INITIALIZED}{TOOLS}{}",
            [
                r#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"canvas_edit"}}"#,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"open"}}"#,
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"canvas_read"}}"#,
                r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"canvas_edit","arguments":{"baseRevision":"v1"}}}"#,
                r#"{"jsonrpc":"2.0","id":"last","method":"ping"}"#,
            ]
            .join("\r\n")
        );
        let reply = run(&input, |request| match request {
            Request::Tools => Ok(json!({"ok":true,"tools":[{"name":"canvas_read"}]})),
            Request::Call { name, arguments } if name == "canvas_read" => {
                assert_eq!(arguments, json!({}));
                Ok(json!({"ok":true,"label":"会议 📝"}))
            }
            Request::Call { name, arguments } => {
                assert_eq!(name, "canvas_edit");
                assert_eq!(arguments, json!({"baseRevision":"v1"}));
                Ok(json!({"ok":false,"code":"STALE","revision":"v2"}))
            }
            _ => panic!("Unexpected bridge command"),
        });
        assert_eq!(reply.len(), 7);
        assert_eq!(reply[0]["id"], "init");
        assert_eq!(reply[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(reply[1]["error"]["code"], -32000);
        assert_eq!(
            reply[2]["result"],
            json!({"tools":[{"name":"canvas_read"}]})
        );
        assert_eq!(reply[3]["error"]["code"], -32602);
        for (index, is_error) in [(4, false), (5, true)] {
            let result = &reply[index]["result"];
            assert_eq!(result["isError"], is_error);
            let text = result["content"][0]["text"].as_str().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(text).unwrap(),
                result["structuredContent"]
            );
        }
        assert_eq!(reply[4]["result"]["structuredContent"]["label"], "会议 📝");
        assert_eq!(reply[5]["result"]["structuredContent"]["code"], "STALE");
        assert_eq!(reply[6], rpc_result(&json!("last"), json!({})));
    }

    #[test]
    fn recovers_after_bad_messages_and_workbench_errors() {
        let oversized = " ".repeat(MAX_LINE + 1);
        let future = INITIALIZE.replace("2025-06-18", "unsupported");
        let input = format!(
            "{oversized}\n{{\n[]\n{future}{INITIALIZED}{TOOLS}{TOOLS}{}",
            r#"{"jsonrpc":"2.0","id":5,"method":"resources/list"}"#
        );
        let mut calls = 0;
        let reply = run(&input, |request| {
            assert!(matches!(request, Request::Tools));
            calls += 1;
            if calls == 1 {
                Err(Failure::new("NO_WINDOW", "Open the workbench"))
            } else {
                Ok(json!({"ok":true,"tools":[]}))
            }
        });
        assert_eq!(calls, 2);
        assert_eq!(reply[0]["error"]["code"], -32700);
        assert_eq!(reply[1]["error"]["code"], -32700);
        assert_eq!(reply[2]["error"]["code"], -32600);
        assert_eq!(reply[3]["result"]["protocolVersion"], VERSIONS[0]);
        assert_eq!(reply[4]["error"]["data"]["code"], "NO_WINDOW");
        assert_eq!(reply[5]["result"], json!({"tools":[]}));
        assert_eq!(reply[6]["error"]["code"], -32601);
    }

    #[test]
    fn eof_is_clean_and_broken_output_stops_dispatch() {
        struct BrokenOutput;
        impl Write for BrokenOutput {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert!(serve_stdio(&b""[..], BrokenOutput, |_| panic!()).is_ok());
        let input = format!("{INITIALIZE}{INITIALIZED}{TOOLS}");
        let error = serve_stdio(input.as_bytes(), BrokenOutput, |_| {
            panic!("Disconnected client")
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }
}
