import {isRecord} from "../core/document.ts";
import {CommandError} from "../features/board-commands.ts";
import type {ToolSchema} from "./canvas-tools.ts";

function invalid(path:string,message:string):never{
  const error=new CommandError("INVALID",path+" "+message);
  error.path=path;
  const index=/^arguments\.operations\[(\d+)\]/.exec(path);
  if(index)error.operationIndex=Number(index[1]);
  throw error;
}

/** Check the schema keywords used in the shared catalog for callers without browser-side validation. */
export function validateToolInput(schema:ToolSchema,value:unknown,path="arguments"):void{
  if(schema.const!==undefined&&value!==schema.const)invalid(path,"must be "+schema.const);
  if(schema.enum&&!schema.enum.some(item=>item===value))invalid(path,"must be one of "+schema.enum.join(", "));
  if(schema.oneOf){
    if(!isRecord(value))invalid(path,"must be an object");
    const matches=schema.oneOf.filter(item=>item.properties?.op?item.properties.op.const===value.op:
      item.required?.every(key=>Object.hasOwn(value,key)));
    if(matches.length!==1)invalid(path,schema.oneOf[0].properties?.op?"has an unknown operation":"must supply exactly one of the alternative inputs");
    validateToolInput(matches[0],value,path);
  }
  if(schema.type==="object"){
    if(!isRecord(value))invalid(path,"must be an object");
    for(const key of schema.required??[])if(!Object.hasOwn(value,key))invalid(path+"."+key,"is required");
    for(const key of Object.keys(value)){
      const field=schema.properties&&Object.hasOwn(schema.properties,key)?schema.properties[key]:undefined;
      if(field)validateToolInput(field,value[key],path+"."+key);
      else if(schema.additionalProperties===false)invalid(path+"."+key,"is not an accepted field");
    }
  }else if(schema.type==="array"){
    if(!Array.isArray(value))invalid(path,"must be an array");
    if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity))invalid(path,"has an invalid number of items");
    if(schema.uniqueItems&&new Set(value).size!==value.length)invalid(path,"contains duplicate IDs");
    if(schema.items)value.forEach((entry,index)=>validateToolInput(schema.items!,entry,path+"["+index+"]"));
  }else if(schema.type==="string"){
    if(typeof value!=="string")invalid(path,"must be a string");
    if(value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)||schema.pattern&&!new RegExp(schema.pattern).test(value))
      invalid(path,"has an invalid length or format");
  }else if(schema.type==="integer"||schema.type==="number"){
    if(typeof value!=="number"||!Number.isFinite(value)||schema.type==="integer"&&!Number.isSafeInteger(value)||
      value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))invalid(path,"must be a valid "+schema.type+" in range");
  }
}
