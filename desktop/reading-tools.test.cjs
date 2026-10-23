const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const {join} = require("node:path");
const {credentialStore} = require("./reading-tools.cjs");
test("protected model keys bind to provider target, serialize writes and reject plaintext stores", async()=>{
 const dir=await fs.mkdtemp(join(os.tmpdir(),"openreading-key-test-"));
 const safe={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>"keychain",encryptString:(s)=>Buffer.from(s).map((b)=>b^127),decryptString:(b)=>Buffer.from(b).map((v)=>v^127).toString()};
 try{const store=credentialStore(dir,safe),a={id:"a".repeat(32),target:"openai\nhttps://provider.example",key:"dummy-test-secret"},b={...a,id:"b".repeat(32)};
  await Promise.all([store("save",a),store("save",b)]);const persisted=await fs.readFile(join(dir,"protected-model-keys.json"),"utf8");assert.ok(!persisted.includes(a.key));assert.equal(await store("load",a),a.key);assert.equal(await store("load",{...a,target:"https://changed.example"}),null);
  await store("forget",a);assert.equal(await store("load",a),null);assert.equal(await store("load",b),a.key);
  await assert.rejects(credentialStore(dir,{...safe,getSelectedStorageBackend:()=>"basic_text"})("save",a));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
