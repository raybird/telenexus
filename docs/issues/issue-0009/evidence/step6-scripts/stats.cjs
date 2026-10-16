const D=require("/app/node_modules/better-sqlite3");const fs=require("fs");
const DB="/home/node/.local/share/opencode/opencode.db";const db=new D(DB,{readonly:true});
const cutoff=Date.now()-30*864e5;
let bound=null;try{bound=Object.values(JSON.parse(fs.readFileSync("/app/data/chat-session-state.json","utf8")))[0]}catch{}
const q=(s,...a)=>db.prepare(s).get(...a);
const out={
 sessions:q("select count(*) n from session").n,
 topLevel:q("select count(*) n from session where parent_id is null").n,
 expiredUnbound:q("select count(*) n from session where parent_id is null and time_updated<? and id<>?",cutoff,bound||"").n,
 boundExists:bound?q("select count(*) n from session where id=?",bound).n:null,
 boundAgeDays:bound?Math.round((Date.now()-(q("select time_updated t from session where id=?",bound)?.t??0))/864e5):null,
 boundMsgs:bound?q("select count(*) n from message where session_id=?",bound).n:null,
 pageCount:db.pragma("page_count",{simple:true}),freelist:db.pragma("freelist_count",{simple:true}),
 fileBytes:fs.statSync(DB).size};
if(process.argv[2]==="pick"){out.pick=q("select id from session s where parent_id is null and time_updated<? and (select count(*) from message m where m.session_id=s.id)>=2 order by time_updated limit 1 offset 200",cutoff).id;}
console.log(JSON.stringify(out));
