import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
test('login cookies persist for fourteen hours and signed sessions expire on the server',()=>{
 const source=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');let now=1000000;
 const context=vm.createContext({crypto,Buffer,SESSION_SECRET:'test',loginSessionMaxAgeMs:14*60*60*1000,Date:{now:()=>now}});
 for(const [start,end] of [['function signSession(', 'async function getJobRecord('],['function setSessionCookie(', 'function buildSessionPayload('],['function currentUser(', 'const authContextCache =']]) vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),context);
 const cookies={},res={cookie:(name,value,options)=>cookies[name]={value,options}};
 context.setSessionCookie(res,{id:7,job_id:101});context.setVendorSessionCookie(res,{id:8});
 const req={cookies:{session_token:cookies.session_token.value,vendor_session_token:cookies.vendor_session_token.value}};
 assert.equal(cookies.session_token.options.maxAge,50400000);assert.equal(cookies.session_token.options.httpOnly,true);assert.equal(cookies.session_token.options.secure,true);
 assert.equal(context.currentUser(req).id,7);assert.equal(context.currentVendorUser(req).id,8);
 now+=50400000-1;assert.equal(context.currentUser(req).id,7);
 now++;assert.equal(context.currentUser(req),null);assert.equal(context.currentVendorUser(req),null);
 assert.equal(context.currentUser({cookies:{session_token:context.signSession({id:7})}}),null);
 assert.equal(context.currentUser({cookies:{session_token:req.cookies.session_token+'bad'}}),null);
});
