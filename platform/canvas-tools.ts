import {drawingShapes,flowDirections} from "../features/flow-drawing-model.ts";
import {MAX_LABEL_LENGTH} from "../features/plain-text.ts";

/** The page, WebMCP registration and local MCP transport share these JSON Schema definitions. */
export type ToolSchema={
  type?:string;description?:string;enum?:readonly string[];const?:string;pattern?:string;
  properties?:Record<string,ToolSchema>;required?:readonly string[];additionalProperties?:boolean;
  items?:ToolSchema;oneOf?:readonly ToolSchema[];uniqueItems?:boolean;
  minimum?:number;maximum?:number;minItems?:number;maxItems?:number;minLength?:number;maxLength?:number;
};
const schemaObject=(properties:Record<string,ToolSchema>,required:string[]=[]):ToolSchema=>({
  type:"object",properties,required,additionalProperties:false,
});
const choice=(...values:string[]):ToolSchema=>({type:"string",enum:values});
const text=(maxLength:number):ToolSchema=>({type:"string",maxLength});
const stableId:ToolSchema={type:"string",pattern:"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",description:"Stable document ID."};
const ids:ToolSchema={type:"array",items:stableId,minItems:1,maxItems:100,uniqueItems:true};
const integer:ToolSchema={type:"integer"},size:ToolSchema={type:"integer",minimum:1};
const point=schemaObject({x:integer,y:integer},["x","y"]);
const write={
  baseRevision:{type:"string",minLength:1,maxLength:160,description:"Exact revision from canvas_read or the last successful write."},
  operationId:{...stableId,description:"Unique request ID. Reuse the same ID and identical arguments when retrying."},
};
const shape=choice("rect","diamond","triangle"),port=choice("north","east","south","west");
const label=text(MAX_LABEL_LENGTH);
const labelFontSize:ToolSchema={type:"integer",minimum:8,maximum:72,description:"Native node or edge label size in world pixels at 100% zoom."};
const nodeFields={id:stableId,label,labelFontSize,shape,width:size,height:size,fill:text(128),stroke:text(128)};
const edgeFields={id:stableId,from:stableId,to:stableId,fromPort:port,toPort:port,label,labelFontSize,
  routing:choice("straight","orthogonal","curve"),arrow:choice("none","start","end","both"),stroke:text(128)};
const op=(name:string,fields:Record<string,ToolSchema>,required:string[])=>schemaObject({op:{const:name},...fields},["op",...required]);
const endpoint:ToolSchema={oneOf:[
  schemaObject({kind:{const:"anchor"},objectId:stableId,portId:port},["kind","objectId","portId"]),
  schemaObject({kind:{const:"free"},point},["kind","point"]),
]};
const updateFields:ToolSchema={type:"object",properties:{at:point,origin:point,width:size,height:size,labelFontSize,from:endpoint,to:endpoint},
  description:"Changed native fields only, e.g. {label}, {at:{x,y}} or {text}. To rewire a connector, set from or to to {kind:'anchor',objectId,portId}. Use canvas_read detail full to inspect other fields."};
const editOperation:ToolSchema={oneOf:[
  op("node",{...nodeFields,x:integer,y:integer},["id","x","y"]),
  op("edge",edgeFields,["id","from","to"]),
  op("update",{id:stableId,group:stableId,fields:updateFields},["id","fields"]),
  op("remove",{id:stableId,group:stableId},["id"]),
]};
const graph=schemaObject({
  direction:choice(...flowDirections),
  nodes:{type:"array",minItems:1,maxItems:1000,items:schemaObject({id:stableId,label,shape:choice(...drawingShapes)},["id"])},
  edges:{type:"array",maxItems:1000,items:schemaObject({id:stableId,from:stableId,to:stableId,label,arrow:choice("end","none","both")},["from","to"])},
  groups:{type:"array",maxItems:1000,items:schemaObject({id:stableId,label,nodeIds:{type:"array",minItems:1,maxItems:1000,uniqueItems:true,items:stableId}},["id","nodeIds"])},
},["nodes","edges"]);
export const canvasToolDefinitions=[
  {name:"canvas_read",description:"Inspect the open board, selection and camera. Use ids, a text query, or selection/viewport scope to get screenText (font sizes in CSS pixels by ID) with each result page. Filter by kind and page with nextOffset. Full native objects are limited to 10 per page.",
    inputSchema:schemaObject({scope:choice("board","selection","viewport"),ids,kind:choice("shape","connector","text","mindmap","ink","image","path","table"),
      query:text(256),detail:choice("summary","full"),offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:100}}),
    annotations:{readOnlyHint:true}},
  {name:"canvas_edit",description:"Atomically create positioned nodes and bound edges, update fields or remove objects by stable ID. Node x/y locate the top-left in integer world units. Use the group ID for member edits. One successful batch is one undo step.",
    inputSchema:schemaObject({...write,label:text(160),operations:{type:"array",minItems:1,maxItems:1000,items:editOperation}},["baseRevision","operationId","operations"])},
  {name:"canvas_draw_flow",description:"Add a laid-out flowchart in one undo step. Supply exactly one of graph (unused document IDs and optional groups) or mermaid (local IDs; one level of subgraph). Returns editable node/edge ID maps and groups with actual id, titleId and nodeIds.",
    inputSchema:schemaObject({...write,graph,mermaid:text(100000),origin:point},["baseRevision","operationId"])},
  {name:"canvas_history",description:"Undo or redo one accessible edit in the open board's shared history. Retry with the original request ID and revision.",
    inputSchema:schemaObject({...write,action:choice("undo","redo")},["baseRevision","operationId","action"])},
  {name:"canvas_view",description:"Fit the board or selected ids clear of the visible toolbars. Locate centers ids at the current zoom. Returns actual CSS viewport, toolbar rectangles, final zoom and screen font sizes for ids or measureIds. Only moves the camera.",
    inputSchema:schemaObject({action:choice("fit","locate"),ids,measureIds:ids},["action"])},
] satisfies {name:string;description:string;inputSchema:ToolSchema;annotations?:{readOnlyHint:boolean}}[];

export type CanvasToolPayload=Record<string,unknown>&{ok:boolean};
export type CanvasToolResult={content:{type:"text";text:string}[];structuredContent:CanvasToolPayload;isError?:boolean};
export interface CanvasTools {
  listTools():typeof canvasToolDefinitions;
  callTool(name:string,args?:unknown,signal?:AbortSignal):Promise<CanvasToolResult>;
}
