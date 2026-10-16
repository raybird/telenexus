const D=require("/app/node_modules/better-sqlite3");
const fs=require("fs");const {execFileSync}=require("child_process");
const DB="/home/node/.local/share/opencode/opencode.db";
const open=()=>new D(DB,{readonly:true});
const TABLES=[["message","session_id"],["part","session_id"],["todo","session_id"],["session_share","session_id"],["session_message","session_id"],["session_input","session_id"],["session_context_epoch","session_id"],["event","aggregate_id"],["event_sequence","aggregate_id"]];
function snap(id){const db=open();const r={session:db.prepare("select count(*) n from session where id=?").get(id).n,children:db.prepare("select count(*) n from session where parent_id=?").get(id).n};
 for(const [t,c] of TABLES) r[t]=db.prepare(`select count(*) n from ${t} where ${c}=?`).get(id).n;
 r.diffFile=fs.existsSync(`/home/node/.local/share/opencode/storage/session_diff/${id}.json`)?1:0;db.close();return r;}
function totals(){const db=open();const r={};for(const t of ["session",...TABLES.map(x=>x[0])])r[t]=db.prepare(`select count(*) n from ${t}`).get().n;
 r.diffFiles=fs.readdirSync("/home/node/.local/share/opencode/storage/session_diff").length;r.pages=db.pragma("page_count",{simple:true});r.freelist=db.pragma("freelist_count",{simple:true});db.close();return r;}
function del(id){const t=Date.now();let ok=true,err="";try{execFileSync("opencode",["session","delete",id],{stdio:["ignore","pipe","pipe"]});}catch(e){ok=false;err=String(e.stderr||e.message).slice(0,300);}return {ms:Date.now()-t,ok,err};}
const [mode,...args]=process.argv.slice(2);
const pick=(sql,...a)=>{const db=open();const r=db.prepare(sql).all(...a);db.close();return r;};
if(mode==="pick"){const now=Date.now();
 console.log(JSON.stringify({
  oldLeaf:pick("select s.id from session s where time_updated<? and parent_id is null and not exists(select 1 from session c where c.parent_id=s.id) and exists(select 1 from part p where p.session_id=s.id) order by time_updated limit 1",now-90*864e5)[0],
  withEvents:pick("select s.id from session s where parent_id is null and not exists(select 1 from session c where c.parent_id=s.id) and exists(select 1 from event e where e.aggregate_id=s.id) order by time_updated limit 1")[0],
  parent:pick("select parent_id id, count(*) n from session where parent_id is not null group by 1 order by n desc limit 1")[0],
 }));}
if(mode==="delete1"){const id=args[0];const b=snap(id),tb=totals();const d=del(id);const a=snap(id),ta=totals();
 const delta={};for(const k of Object.keys(tb))delta[k]=ta[k]-tb[k];console.log(JSON.stringify({before:b,after:a,delete:d,totalsDelta:delta}));}
if(mode==="totals"){console.log(JSON.stringify(totals()));}
