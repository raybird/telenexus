const D=require("/app/node_modules/better-sqlite3");const {spawn}=require("child_process");const DB="/home/node/.local/share/opencode/opencode.db";
const pre=new D(DB,{readonly:true});const fl=pre.pragma("freelist_count",{simple:true}),pc=pre.pragma("page_count",{simple:true});pre.close();
const w0=new D(DB,{timeout:0}),r0=new D(DB,{readonly:true,timeout:0}),w5=new D(DB,{timeout:5000});
const stats={write_t0:{ok:0,busy:0},read_t0:{ok:0,busy:0},write_t5000:{ok:0,busy:0,maxWaitMs:0}};
const t0=Date.now();let done=false,vac;
const c=spawn("opencode",["db","VACUUM"]);c.on("close",code=>{vac={code,ms:Date.now()-t0};done=true;});
(function loop(){ if(done&&Date.now()-vac.ms-t0>300){finish();return;}
 try{w0.prepare("insert into probe_tmp values (3)").run();stats.write_t0.ok++}catch(e){stats.write_t0.busy++}
 try{r0.prepare("select count(*) from session").get();stats.read_t0.ok++}catch(e){stats.read_t0.busy++}
 const s=Date.now();try{w5.prepare("insert into probe_tmp values (4)").run();stats.write_t5000.ok++}catch(e){stats.write_t5000.busy++}
 stats.write_t5000.maxWaitMs=Math.max(stats.write_t5000.maxWaitMs,Date.now()-s);
 setTimeout(loop,20);})();
function finish(){const p=new D(DB,{readonly:true});console.log(JSON.stringify({before:{pages:pc,freelist:fl},vacuum:vac,after:{pages:p.pragma("page_count",{simple:true}),freelist:p.pragma("freelist_count",{simple:true})},contention:stats}));}
