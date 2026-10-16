const D=require("/app/node_modules/better-sqlite3");const {execFileSync}=require("child_process");const DB="/home/node/.local/share/opencode/opencode.db";
const q=(s,...a)=>{const db=new D(DB,{readonly:true});const r=db.prepare(s).all(...a);db.close();return r;};
const mode=process.argv[2];
if(mode==="prep"){const cutoff=Date.now()-30*864e5;
 const bound=q("select id,time_updated from session s where parent_id is null and time_updated<? and (select count(*) from message m where m.session_id=s.id)>=2 order by time_updated limit 1 offset 20",cutoff)[0];
 const victims=q("select id from session where parent_id is null and time_updated<? and id<>? order by time_updated limit 50",cutoff,bound.id).map(r=>r.id);
 let fail=0;for(const id of victims){try{execFileSync("opencode",["session","delete",id],{stdio:"ignore"})}catch{fail++}}
 const olderLeft=q("select count(*) n from session where parent_id is null and time_updated<? and id<>?",bound.time_updated,bound.id)[0].n;
 console.log(JSON.stringify({bound:bound.id,boundAgeDays:Math.round((Date.now()-bound.time_updated)/864e5),deletedAround:victims.length,fail,olderThanBoundLeft:olderLeft,victimSample:victims[0]}));}
if(mode==="count"){const id=process.argv[3];console.log(JSON.stringify({exists:q("select count(*) n from session where id=?",id)[0].n,msgs:q("select count(*) n from message where session_id=?",id)[0].n,sessions:q("select count(*) n from session")[0].n}));}
