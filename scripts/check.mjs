import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { transformSync } from "esbuild";
for (const directory of ["core","features","session","scene","renderers","platform","app","scripts","tests"]) {
  for (const entry of readdirSync(directory,{recursive:true,withFileTypes:true})) {
    if (!entry.isFile() || !/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
    const file=join(entry.parentPath,entry.name);
    if(entry.name.endsWith(".tsx")){
      transformSync(readFileSync(file,"utf8"),{loader:"tsx",jsx:"automatic",sourcefile:file});
      continue;
    }
    const checked=spawnSync(process.execPath,["--check",file],{stdio:"inherit"});
    if (checked.status !== 0) process.exit(checked.status ?? 1);
  }
}
