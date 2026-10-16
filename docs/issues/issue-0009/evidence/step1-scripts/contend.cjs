const D=require("/app/node_modules/better-sqlite3");const DB="/home/node/.local/share/opencode/opencode.db";
const res={};const t=()=>Date.now();
function attempt(name,timeout,fn){const db=new D(DB,{timeout});const s=t();try{fn(db);res[name]={ok:true,ms:t()-s}}catch(e){res[name]={ok:false,ms:t()-s,err:e.code||e.message}}db.close();}
attempt("read_t0",0,db=>db.prepare("select count(*) from session").get());
attempt("write_t0",0,db=>{db.exec("create table if not exists probe_tmp(x)");db.prepare("insert into probe_tmp values (1)").run();});
attempt("read_t5000",5000,db=>db.prepare("select count(*) from session").get());
attempt("write_t5000",5000,db=>db.prepare("insert into probe_tmp values (2)").run());
console.log(JSON.stringify(res));
