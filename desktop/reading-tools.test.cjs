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
const {parseTesseractTsv,recognizePage}=require('./reading-tools.cjs');
test('OCR details retain line ordering, conservative confidence and normalized bounds',()=>{
 const header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
 const rows=['1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t','5\t1\t1\t1\t1\t1\t100\t200\t100\t40\t98\tHello','5\t1\t1\t1\t1\t2\t220\t200\t100\t40\t70\tworld','5\t1\t1\t1\t2\t1\t100\t300\t100\t40\t95\tNext'];
 const lines=parseTesseractTsv([header,...rows].join('\n'));
 assert.equal(lines.length,2);assert.equal(lines[0].text,'Hello world');assert.equal(lines[0].confidence,.7);
 assert.equal(lines[0].box.x,.1);assert.equal(lines[0].box.width,.22);assert.equal(lines[1].text,'Next');
});
test('OCR rejects non-PNG and oversized input before invoking local tools',async()=>{
 for(const image of ['not an image','data:image/png;base64,ZmFrZQ==','data:image/png;base64,'+'A'.repeat(32*1024*1024)])
  await assert.rejects(recognizePage(image,'/private/tmp','/private/tmp',true));
});
