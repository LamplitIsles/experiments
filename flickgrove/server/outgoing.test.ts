import { expect, test } from "bun:test";
import { compileModule } from "svelte/compiler";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pending lookup preserves identity and accepted results are monotonic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-outgoing-"));
  try {
    const sourcePath = import.meta.dir + "/../src/outgoing.svelte.ts";
    const source = new Bun.Transpiler({ loader: "ts" })
      .transformSync(readFileSync(sourcePath, "utf8"))
      .replace(
        '"./image-drafts"',
        JSON.stringify(import.meta.dir + "/../src/image-drafts.ts"),
      )
      .replace(
        '"./chord-contract"',
        JSON.stringify(import.meta.dir + "/../src/chord-contract.ts"),
      );
    const compiled = compileModule(source, {
      filename: sourcePath,
      generate: "client",
    })
      .js.code.replaceAll(
        'from "zod"',
        `from ${JSON.stringify(import.meta.resolve("zod"))}`,
      )
      .replaceAll(
        '"svelte/internal/client"',
        JSON.stringify(import.meta.resolve("svelte/internal/client")),
      );
    writeFileSync(
      join(directory, "outgoing.mjs"),
      compiled.replaceAll(
        "'svelte/internal/client'",
        JSON.stringify(import.meta.resolve("svelte/internal/client")),
      ),
    );
    writeFileSync(
      join(directory, "check.ts"),
      `
      import { strict as assert } from "node:assert";
      const records = new Map();
      const prefix = "flickgrove/http://fixture.invalid/outgoing/peer%3Aorc/";
      const images = [{id:"a".repeat(64),name:"kept.png",width:8,height:8,bytes:80,mediaType:"image/png"}];
      for (const [id,status] of [["held","sending"],["unknown","uncertain"],["confirmed","sent"],["refused","failed"]])
        records.set(prefix+id,JSON.stringify({agentId:"peer:orc",id,text:"kept "+id,at:123,status,images,localImageIds:["local-image"],answers:[{questionId:"original",answer:"kept answer"}]}));
      Object.assign(globalThis, {location: {origin: "http://fixture.invalid"}, window: {addEventListener() {}}, localStorage: new Proxy({
        getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key)
      }, {ownKeys:()=>[...records.keys()],getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})})});
      const {addOutgoing, acceptReceipt, observeOutgoing, outgoing, receiptAlreadyAccepted, withOutgoing, submissionResult} = await import("./outgoing.mjs");
      assert.deepEqual(outgoing.entries.map(o=>[o.id,o.status]),[["held","pending"],["unknown","pending"],["confirmed","accepted"],["refused","rejected"]]);
      assert.equal(JSON.stringify(outgoing.entries[0].images),JSON.stringify(images));
      assert.equal(JSON.stringify(outgoing.entries[0].answers),JSON.stringify([{questionId:"original",answer:"kept answer"}]));
      assert.equal(JSON.stringify(outgoing.entries[0].localImageIds),JSON.stringify(["local-image"]));
      assert.equal(outgoing.entries[0].at,123);
      outgoing.entries = [];
      records.clear();
      // No device-owned operation exists: owner observations still confirm its identity.
      for (const source of ["user", "question"]) {
        const id = "server-" + source;
        const delivery = {id,status:"sent",source,text:"server content",at:123,questionIds:source === "question" ? ["q"] : [],...(source === "question" ? {answers:[{questionId:"q",answer:"confirmed answer"}]} : {})};
        observeOutgoing({id:"peer:orc",messages:[{id,role:"user",text:delivery.text,at:123}],deliveries:[delivery]});
        assert.equal(receiptAlreadyAccepted("peer:orc",id),true);
        assert.equal(outgoing.entries.length,0);
        acceptReceipt("peer:orc",null);
        acceptReceipt("peer:orc",{operationId:id,state:"rejected",turnId:null,error:"late failure"});
        const late = withOutgoing({id:"peer:orc",messages:[],questions:[{id:"q",state:"unanswered"}],deliveries:[{...delivery,status:"uncertain",error:"late unknown"}]});
        assert.equal(submissionResult(late.deliveries[0]),"accepted");
        assert.equal(late.deliveries[0].error,undefined);
        assert.equal(late.deliveries[0].source,source);
        assert.equal(late.messages.length,1);
        if(source === "question") {
          assert.equal(late.questions[0].state,"answered");
          assert.equal(late.questions[0].answer,"confirmed answer");
        }
      }
      // A matching observed user message is confirmation even beside a stale delivery.
      observeOutgoing({id:"peer:orc",messages:[{id:"seen-user",role:"user"}],deliveries:[{id:"seen-user",status:"uncertain",source:"user"}]});
      assert.equal(receiptAlreadyAccepted("peer:orc","seen-user"),true);
      // Saved sent is authoritative without a local journal or visible message.
      observeOutgoing({id:"peer:orc",messages:[],deliveries:[{id:"sent-only",status:"sent",source:"user"}]});
      assert.equal(receiptAlreadyAccepted("peer:orc","sent-only"),true);
      observeOutgoing({id:"peer:orc",messages:[{id:"assistant",role:"assistant"},{id:"history",role:"user"}],deliveries:[{id:"assistant",status:"sending",source:"user"}]});
      assert.equal(receiptAlreadyAccepted("peer:orc","assistant"),false);
      assert.equal(receiptAlreadyAccepted("peer:orc","history"),false);
      assert.equal(receiptAlreadyAccepted("other:orc","server-user"),false);
      addOutgoing("peer:orc", "draft", "op");
      assert.throws(()=>addOutgoing("peer:orc","changed","op"),/bound/);
      acceptReceipt("peer:orc", null);
      assert.equal(outgoing.entries[0].status, "pending");
      const detail = status => ({id: "peer:orc", messages: [], deliveries: [{id: "op", status}]});
      observeOutgoing(detail("uncertain"));
      assert.equal(outgoing.entries[0].status, "pending");
      observeOutgoing(detail("queued"));
      assert.equal(outgoing.entries[0].status, "pending");
      observeOutgoing(detail("sent"));
      assert.equal(outgoing.entries[0].status, "accepted");
      assert.equal(receiptAlreadyAccepted('peer:orc','op'),true);
      acceptReceipt("peer:orc", null);
      observeOutgoing(detail("queued"));
      observeOutgoing(detail("uncertain"));
      acceptReceipt('peer:orc',{operationId:'op',state:'rejected',turnId:null,error:'late'});
      assert.equal(outgoing.entries[0].status, "accepted");
      observeOutgoing({id:'peer:orc',messages:[{id:'op',role:'user'}],deliveries:[]});
      assert.equal(outgoing.entries.length,0);
      const stale = withOutgoing({id:'peer:orc',messages:[],questions:[],deliveries:[{id:'op',status:'uncertain',source:'user',text:'draft',at:1,questionIds:[]}]});
      assert.equal(stale.deliveries[0].status,'sent');
      assert.equal(stale.messages.length,1);
      assert.equal(receiptAlreadyAccepted('peer:orc','op'),true);
      acceptReceipt('peer:orc',{operationId:'op',state:'rejected',turnId:null,error:'late'});
      assert.equal(outgoing.entries.length,0);
      addOutgoing('peer:orc','second','second');
      observeOutgoing({id:'peer:orc',messages:[],deliveries:[{id:'second',status:'sent'}]});

      assert.equal(outgoing.entries[0].status, "accepted");
      const mutableImages = structuredClone(images);
      addOutgoing("peer:orc","image","image",undefined,mutableImages,["local-image"]);
      mutableImages[0].name = "changed outside";
      assert.equal(outgoing.entries.find(o=>o.id==="image").images[0].name,"kept.png");
      assert.throws(()=>addOutgoing("peer:orc","image","image",undefined,[...mutableImages],["local-image"]),/bound/);
    `,
    );
    const child = Bun.spawn([process.execPath, join(directory, "check.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
