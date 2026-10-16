const D=require("/app/node_modules/better-sqlite3");const {execFileSync}=require("child_process");
const DB="/home/node/.local/share/opencode/opencode.db";
const q=(s)=>{const db=new D(DB,{readonly:true});const r=db.prepare(s).all();db.close();return r;};
const mode=process.argv[2];
if(mode==="multi"){const ids=q("select id from session where parent_id is null order by time_updated limit 2").map(r=>r.id);
 let out;try{out=execFileSync("opencode",["session","delete",...ids],{stdio:["ignore","pipe","pipe"]}).toString()}catch(e){out="ERR "+e.stderr}
 console.log(JSON.stringify({remaining:ids.map(id=>q(`select count(*) n from session where id='${id}'`)[0].n),out:out.slice(0,200)}));}
if(mode==="bulk"){const n=+process.argv[3];const ids=q(`select id from session where parent_id is null order by time_updated limit ${n}`).map(r=>r.id);
 const before=q("select count(*) n from session")[0].n;const t0=Date.now();const per=[];let fail=0;
 for(const id of ids){const t=Date.now();try{execFileSync("opencode",["session","delete",id],{stdio:"ignore"})}catch{fail++}per.push(Date.now()-t);}
 per.sort((a,b)=>a-b);const db=new D(DB,{readonly:true});
 console.log(JSON.stringify({deleted:ids.length,fail,totalMs:Date.now()-t0,p50:per[per.length>>1],p95:per[Math.floor(per.length*.95)],max:per[per.length-1],sessionsBefore:before,sessionsAfter:db.prepare("select count(*) n from session").get().n,pages:db.pragma("page_count",{simple:true}),freelist:db.pragma("freelist_count",{simple:true})}));}
