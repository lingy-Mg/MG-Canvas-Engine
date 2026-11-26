# 连接 Windows 工作台的 MCP 客户端

安装 MG Canvas 后，打开工作台并载入要编辑的画板。在支持本地 MCP stdio 的客户端中加入以下服务配置。将 `command` 改为安装目录中 `mgcanvas.exe` 的绝对路径。默认目录可在 PowerShell 中用 `Join-Path $env:LOCALAPPDATA 'MG Canvas\mgcanvas.exe'` 查看。

```json
{
  "mcpServers": {
    "mgcanvas": {
      "command": "C:/Users/your-name/AppData/Local/MG Canvas/mgcanvas.exe",
      "args": ["mcp"]
    }
  }
}
```

客户端启动 `mgcanvas.exe mcp`，由它通过本机 IPC 连接当前 Windows 用户已打开的工作台。切换工程后，工具会访问切换后的画板。客户端只需允许运行此本地命令，即可通过 stdio 使用画布工具。服务的工具目录限于工作台提供的五个工具。

| 工具 | 用法 |
| --- | --- |
| `canvas_read` | 读取画板、选区和视口。可用 `ids` 或 `query` 定位对象，返回当前 `revision`。 |
| `canvas_edit` | 在一次事务中新增、修改或删除对象与连线。批次对应一次撤销。 |
| `canvas_draw_flow` | 用 Mermaid 或结构化图定义创建可编辑的流程图。 |
| `canvas_history` | 在当前工作台的历史中执行撤销或重做。 |
| `canvas_view` | 定位对象或适配视口，返回当前显示位置与字号。 |

可先让客户端执行 `canvas_read` 查找目标对象，再用返回的 `revision` 作为 `baseRevision`，给本次编辑分配唯一的 `operationId`。在工作台按撤销，或者用最新修订调用 `canvas_history`，都操作同一份历史。请求超时且结果未知时，先重新读取当前画板。需要重试同一次编辑时，原样发送它的参数，包括原有的 `baseRevision` 和 `operationId`。

收到 `NO_WINDOW` 时，打开工作台后重试。遇到 `BUSY` 时，在界面完成当前输入或文件操作。遇到 `STALE` 时，先读取最新对象和修订，再决定下一次编辑。工具调用返回结构化结果及同内容的 JSON 文本，客户端可据此显示或处理错误。

[画布工具参数与示例](AI-CLI.md#页面画布工具)
