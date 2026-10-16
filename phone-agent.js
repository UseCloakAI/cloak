/* Phone agent (CloakPhoneAgent): Settings → Agent is a chat with the Cloak Agent phone
   (android-agent/), and Admin holds the "admins only" toggle (agent_config). Messages are
   agent_messages rows; the phone polls pending ones, answers, and writes the reply back,
   which lands here over Realtime. Admins get phone control on the phone side; everyone
   else gets chat only, and only while the toggle is off. RLS enforces both. */
(function(){
  let ch=null,rows=[],adminsOnly=true;
  const $=id=>document.getElementById(id);
  const COLS='id,role,content,status,created_at';

  async function init(){
    if(typeof sb==='undefined'||!sb||!uid)return;
    try{
      const{data}=await sb.from('agent_config').select('admins_only').eq('id',1).maybeSingle();
      adminsOnly=data?!!data.admins_only:true;
    }catch(e){adminsOnly=true;}
    const t=$('pa-admins-only');if(t)t.checked=adminsOnly;
    const open=admin||!adminsOnly;
    const nav=$('snav-agent');if(nav)nav.style.display=open?'flex':'none';
    if(!open)return;
    await load();subscribe();
  }

  async function load(){
    const{data,error}=await sb.from('agent_messages').select(COLS).eq('user_id',uid).order('id',{ascending:false}).limit(50);
    if(error){status(error.message);return;}
    rows=(data||[]).reverse();render();
  }

  function subscribe(){
    if(ch)return;
    ch=sb.channel('agent-'+uid)
      .on('postgres_changes',{event:'*',schema:'public',table:'agent_messages',filter:'user_id=eq.'+uid},p=>{
        if(p.eventType==='DELETE'){rows=rows.filter(r=>r.id!==p.old?.id);render();return;}
        const r=p.new;if(!r||!r.id)return;
        const i=rows.findIndex(x=>x.id===r.id);
        if(i>=0)rows[i]=r;else rows.push(r);
        rows.sort((a,b)=>a.id-b.id);render();
      }).subscribe();
  }

  function render(){
    const el=$('pa-thread');if(!el)return;
    if(!rows.length){el.innerHTML='<div class="pa-empty">Say something. The phone answers in a few seconds when it\'s online.</div>';return;}
    el.innerHTML=rows.map(r=>'<div class="pa-msg pa-'+r.role+(r.status==='error'?' pa-err':'')+'">'+hesc(r.content)+
      (r.role==='user'&&r.status==='pending'?'<span class="pa-wait">Waiting for the phone…</span>':'')+'</div>').join('');
    el.scrollTop=el.scrollHeight;
  }

  function status(t){const s=$('pa-status');if(s)s.textContent=t||'';}

  async function send(){
    const inp=$('pa-input');const m=inp.value.trim();if(!m)return;
    inp.value='';status('');
    const{data,error}=await sb.from('agent_messages').insert({role:'user',content:m.slice(0,4000)}).select(COLS).single();
    if(error){inp.value=m;status(/row-level|policy/i.test(error.message)?'The agent is admin-only right now.':error.message);return;}
    if(!rows.some(x=>x.id===data.id))rows.push(data);
    render();
  }

  function key(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}

  async function setAdminsOnly(on){
    if(!admin)return;
    const{error}=await sb.from('agent_config').update({admins_only:on,updated_at:new Date().toISOString(),updated_by:uid}).eq('id',1);
    if(error){log('err','Agent access: '+error.message);const t=$('pa-admins-only');if(t)t.checked=!on;return;}
    adminsOnly=on;log('inf','Phone agent: '+(on?'admins only':'open to signed-in users (chat only)'));
  }

  async function clear(){
    if(!confirm('Clear your chat with the phone agent? It also forgets the conversation.'))return;
    const{error}=await sb.from('agent_messages').delete().eq('user_id',uid);
    if(error){status(error.message);return;}
    rows=[];render();
    // Tell the phone to drop its memory of this chat too.
    await sb.from('agent_messages').insert({role:'user',content:'/new'});
  }

  function reset(){
    if(ch&&typeof sb!=='undefined'&&sb){sb.removeChannel(ch);}
    ch=null;rows=[];render();
    const nav=$('snav-agent');if(nav)nav.style.display='none';
  }

  window.CloakPhoneAgent={init,send,key,setAdminsOnly,clear,reset};
})();
