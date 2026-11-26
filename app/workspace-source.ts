export type WorkspaceSource={kind:"local";embeddedProject?:string}|{kind:"cli"};

/** Both markers are part of the built HTML entry contract. */
export function readWorkspaceSource(document:Document):WorkspaceSource{
  return document.getElementById("mgcanvas-bridge")
    ? {kind:"cli"}
    : {kind:"local",embeddedProject:document.getElementById("mgcanvas-project")?.textContent??undefined};
}
