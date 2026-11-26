import {batchLimit,FlowDrawingError,flowDirections,readGraph} from "./flow-drawing-model.ts";
import type {CompactFlowGraph,DrawingEdge,DrawingNode,DrawingShape,FlowDirection,SourceLocation} from "./flow-drawing-model.ts";

// Delimiters are consumed inside labels, so quoted Chinese text may contain pipes, brackets and semicolons.
const shapes:readonly [string,string,DrawingShape][]=[
  ["([","])","stadium"],["((","))","circle"],["[","]","rect"],["(",")","rounded"],["{","}","diamond"],
];
const idPattern=/[A-Za-z0-9](?:[A-Za-z0-9_]|[.-](?=[A-Za-z0-9_]))*/y;
const commands=new Set(["subgraph","end","class","classDef","style","linkStyle","click","direction","accTitle","accDescr"]);
class Line{
  source:string;number:number;pos=0;
  constructor(source:string,number:number){this.source=source;this.number=number;}
  at():SourceLocation{return {line:this.number,column:this.pos+1};}
  error(message:string,pos=this.pos):never{throw new FlowDrawingError("mermaid",message,{line:this.number,column:pos+1});}
  space(){while(this.pos<this.source.length&&/\s/.test(this.source[this.pos]))this.pos++;}
  starts(s:string){return this.source.startsWith(s,this.pos);}
  take(s:string){if(!this.starts(s))return false;this.pos+=s.length;return true;}
  id(){
    this.space();idPattern.lastIndex=this.pos;
    const match=idPattern.exec(this.source);
    if(!match)this.error("此处需要 ASCII 节点 ID，中文名称可写在方括号中");
    this.pos=idPattern.lastIndex;
    if(commands.has(match[0]))this.error("此处不能使用关键字或样式指令 "+match[0],this.pos-match[0].length);
    return match[0];
  }
  text(value:string,start:number){
    const unsupported=/<(?!br\s*\/?>)[A-Za-z/!]|&(?:#\d+|[A-Za-z]+);|#[a-zA-Z0-9]+;/iu;
    const bad=unsupported.exec(value);
    if(bad)this.error("标签支持纯文本及 <br/> 换行，此处的标记不受支持",start+bad.index);
    if(value.startsWith("\x60")||value.endsWith("\x60"))this.error("不支持 Markdown 格式的标签",start);
    return value.replace(/<br\s*\/?>/gi,"\n");
  }
  label(close:string){
    this.space();const quoted=this.take('"'),start=this.pos;
    const end=this.source.indexOf(quoted?'"':close,this.pos);
    if(end<0)this.error("标签缺少闭合符 "+(quoted?'"':close),start-1);
    const raw=this.source.slice(start,end);this.pos=end+(quoted?1:close.length);
    if(quoted){this.space();if(!this.take(close))this.error("标签后应为 "+close);}
    return this.text(quoted?raw:raw.trim(),start);
  }
  node():DrawingNode{
    const id=this.id();this.space();
    if(["[[","[(","[/","[\\","{{","(((",">","@{"].some(token=>this.starts(token)))this.error("当前入口不支持这种节点形状");
    for(const [open,close,shape] of shapes)if(this.take(open))return {id,shape,label:this.label(close)};
    return {id};
  }
  edge(){
    this.space();const spot=this.at();let id:string|undefined;
    if(/^[A-Za-z0-9]/.test(this.source[this.pos]??"")){
      id=this.id();if(!this.take("@"))this.error("边 ID 后应为 @",spot.column-1);
    }
    if(/^---?[ox]/.test(this.source.slice(this.pos)))this.error("不支持圆头或叉头连线。普通无箭头连线可在 --- 后留空格");
    let arrow:DrawingEdge["arrow"],label:string|undefined;
    if(this.take("<-->"))arrow="both";
    else if(this.take("-->"))arrow="end";
    else if(this.take("---"))arrow="none";
    else if(this.take("--")){
      this.space();const start=this.pos;
      if(this.starts('"'))label=this.labelQuotedEdge();
      else{
        const end=this.source.indexOf("-->",this.pos);
        if(end<0||this.source.slice(start,end).includes(";"))this.error("带文字的连线应写为 -- 文字 -->",start);
        label=this.text(this.source.slice(start,end).trim(),start);this.pos=end;
      }
      this.space();if(!this.take("-->"))this.error("边标签后应为 -->");arrow="end";
    }else this.error("支持 -->、---、<--> 和 -- 文字 -->，此处无法解析");
    this.space();
    if(this.take("|")){
      if(label!==undefined)this.error("同一条边有两个标签");
      label=this.label("|");
    }
    return {id,label,arrow,spot};
  }
  labelQuotedEdge(){
    this.pos++;const start=this.pos,end=this.source.indexOf('"',start);
    if(end<0)this.error("边标签缺少结束引号",start-1);
    this.pos=end+1;return this.text(this.source.slice(start,end),start);
  }
}

export function parseMermaidFlow(source:string):CompactFlowGraph{
  if(typeof source!=="string")throw new FlowDrawingError("mermaid","应为 Mermaid 源码字符串");
  const lines=source.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").split("\n");
  const first=lines.findIndex(s=>s.trim()!=="");
  if(first>=0&&lines[first].trim()==="\x60\x60\x60mermaid"){
    const last=lines.findLastIndex(s=>s.trim()!=="");
    if(last===first||lines[last].trim()!=="\x60\x60\x60")throw new FlowDrawingError("mermaid","代码围栏未闭合",{line:first+1,column:1});
    lines[first]=lines[last]="";
  }
  let direction:FlowDirection|undefined;
  const nodes:DrawingNode[]=[],edges:DrawingEdge[]=[],index=new Map<string,number>(),locations=new Map<string,SourceLocation>();
  const groups:{id:string;label:string;nodeIds:string[];open:SourceLocation}[]=[],groupIds=new Set<string>();
  let current:typeof groups[number]|undefined;
  const explicit=new Map<string,string>(),inferred=new Map<string,string>();
  function claim(id:string,where:SourceLocation){
    if(!current)return;
    if(explicit.has(id)&&explicit.get(id)!==current.id)throw new FlowDrawingError("mermaid","节点在两个分区中重复声明："+id,where);
    explicit.set(id,current.id);
  }
  for(const [i,line] of lines.entries()){
    const p=new Line(line,i+1);
    const group=()=>{
      const ids:string[]=[];
      do{
        p.space();const where=p.at(),node=p.node();
        let n=index.get(node.id);
        if(n===undefined){
          n=nodes.length;index.set(node.id,n);nodes.push(node);
          locations.set("graph.nodes["+n+"]",where);
        }else if(node.label!==undefined)nodes[n]=node; // Mermaid's last explicit declaration wins.
        if(node.label!==undefined)locations.set("graph.nodes["+n+"].label",where);
        if(current){
          if(!inferred.has(node.id))inferred.set(node.id,current.id);
          if(node.label!==undefined)claim(node.id,where);
        }
        ids.push(node.id);p.space();
        if(nodes.length+edges.length>batchLimit)p.error("超过单次原生操作上限 "+batchLimit);
      }while(p.take("&"));
      return ids;
    };
    while(p.pos<line.length){
      p.space();if(p.pos===line.length)break;
      if(p.starts("%%{"))p.error("不支持 Mermaid 配置指令");
      if(p.starts("%%"))break;
      if(p.take(";"))continue;
      if(!direction){
        const where=p.at(),head=/^(?:flowchart|graph)\b/.exec(line.slice(p.pos));
        if(!head)p.error("以 flowchart TD 或 graph LR 等流程图声明开头");
        p.pos+=head[0].length;p.space();
        const dir=/^[A-Za-z]+/.exec(line.slice(p.pos));
        if(dir&&!flowDirections.some(d=>d===dir[0]))p.error("方向应为 TD、TB、BT、LR 或 RL");
        direction=(dir?.[0]??"TD") as FlowDirection;p.pos+=dir?.[0].length??0;
        locations.set("graph",where);
      }else if(/^subgraph\b/.test(line.slice(p.pos))){
        if(current)p.error("目前只支持单层 subgraph，请先用 end 结束当前分区");
        const open=p.at();p.pos+="subgraph".length;p.space();const id=p.id();p.space();
        if(groupIds.has(id))p.error("重复的分区 ID "+id,open.column-1);
        const label=p.take("[")?p.label("]"):id;
        current={id,label,nodeIds:[],open};
        locations.set("graph.groups["+groups.length+"]",open);groups.push(current);groupIds.add(id);
      }else if(/^end\b/.test(line.slice(p.pos))){
        if(!current)p.error("此处没有待结束的 subgraph");
        current=undefined;p.pos+=3;
      }else{
        const where=p.at();let from=group(),hasEdge=false;p.space();
        while(p.pos<line.length&&!p.starts(";")&&!p.starts("%%")){
          hasEdge=true;
          const {id,label,arrow,spot}=p.edge(),to=group();
          if(id&&from.length*to.length!==1)p.error("一条显式边 ID 只能对应一条连线",spot.column-1);
          for(const a of from)for(const b of to){
            if(nodes.length+edges.length>=batchLimit)p.error("超过单次原生操作上限 "+batchLimit,spot.column-1);
            locations.set("graph.edges["+edges.length+"]",spot);
            edges.push({from:a,to:b,id,label,arrow});
          }
          from=to;p.space();
        }
        if(!hasEdge)for(const id of from)claim(id,where);
      }
      p.space();if(p.pos<line.length&&!p.starts(";")&&!p.starts("%%"))p.error("声明后请使用换行或分号");
    }
  }
  if(!direction)throw new FlowDrawingError("mermaid","缺少 flowchart 或 graph 声明",{line:1,column:1});
  if(current)throw new FlowDrawingError("mermaid","分区 "+current.id+" 缺少 end",current.open);
  const byId=new Map(groups.map(group=>[group.id,group]));
  for(const [i,edge] of edges.entries()){
    if(byId.has(edge.from)||byId.has(edge.to))throw new FlowDrawingError("mermaid","连线应引用分区里的节点 ID，不能直接连到分区 ID",
      locations.get("graph.edges["+i+"]"));
  }
  for(const node of nodes){
    const owner=explicit.get(node.id)??inferred.get(node.id);
    if(owner)byId.get(owner)!.nodeIds.push(node.id);
  }
  for(const group of groups)if(!group.nodeIds.length)throw new FlowDrawingError("mermaid","分区 "+group.id+" 至少需要一个节点",group.open);
  return readGraph({direction,nodes,edges,groups:groups.map(({open,...group})=>group)},locations);
}
