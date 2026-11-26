let counter=0;
export function allocateId(prefix:string):string{
  return prefix+"-"+(globalThis.crypto?.randomUUID?.()??Date.now().toString(36)+"-"+(++counter));
}
