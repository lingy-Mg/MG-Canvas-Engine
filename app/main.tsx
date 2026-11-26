import {createRoot} from "react-dom/client";
import {WorkspaceApp} from "./react/WorkspaceApp.tsx";
import {readWorkspaceSource} from "./workspace-source.ts";

const host=document.getElementById("root");
if(!host)throw new Error("缺少编辑器挂载点");
const source=readWorkspaceSource(document);
createRoot(host).render(<WorkspaceApp source={source} version={host.dataset.previewVersion??""}/>);
