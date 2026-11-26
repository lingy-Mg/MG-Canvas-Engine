import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const args=process.argv.slice(2);
const lan=args[0]==="--lan";
const host=lan?args[1]:"127.0.0.1";
const octets=host?.split(".").map(Number)??[];
const validPrivateAddress=host&&/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)&&octets.every(x=>x<=255)&&(
  octets[0]===10||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]>=16&&octets[1]<=31
);
if(args.length&&(!lan||args.length!==2||!validPrivateAddress)){
  console.error("Use npm run preview, or npm run preview -- --lan <specific private IPv4 address>.");
  process.exit(1);
}
const port=Number(process.env.PORT??5173);
const base=fileURLToPath(new URL(lan?"../dist/desktop/":"../dist/",import.meta.url));
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
createServer(async (request,response)=>{
  try{
    const path=decodeURIComponent(new URL(request.url,"http://localhost").pathname);
    if(path==="/"){response.writeHead(302,{ Location:lan?"/index.html":"/app/index.html" }).end();return;}
    const target=resolve(base,"."+path);
    if(!target.startsWith(base.endsWith(sep)?base:base+sep)){response.writeHead(403).end();return;}
    if(lan&&(request.method!=="GET"&&request.method!=="HEAD"||!Object.hasOwn(mime,extname(target)))){response.writeHead(404).end();return;}
    const body=await readFile(target);
    response.writeHead(200,{"Content-Type":mime[extname(target)]??"application/octet-stream","Cache-Control":"no-store"}).end(body);
  }catch{response.writeHead(404).end("Not found");}
}).listen(port,host,function(){
  console.log((lan?"Private-network test (built files only; stop with Ctrl+C) ":"Local preview ")+"http://"+host+":"+this.address().port);
});
