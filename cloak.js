const SB_URL='https://kdawsqrrmwirilyhcolk.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkYXdzcXJybXdpcmlseWhjb2xrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjUxNjAsImV4cCI6MjA4OTU0MTE2MH0.cMN9V51J3042DrdaDmL7-ro-AMaw-IU47wQLnW2NMBE';
const ADMIN='weston07052010@gmail.com';
const GUEST_MAX=10;

/* ── CLOAK API ── */
const CLOAK_API='https://api.usecloak.org';

let sb=null,busy=false,entering=false;
let dark=localStorage.getItem('cloak_dark')!=='0';
let currentTheme=localStorage.getItem('cloak_theme')||'default';
let temp=parseFloat(localStorage.getItem('cloak_temp')||'0.7');
let extraPrompt=localStorage.getItem('cloak_extra_prompt')||'';
let email='',uid='',name='',admin=false;
let guest=false,guestN=0;
let verifyEmail='';
let convs=[],chatId=null,hist=[],logs=[],logF='all',stats={req:0,res:0,err:0,lat:[]},atab='general';
let annId=null;
let hwMode=false, thinkModeActive=false, attachedImgs=[];
let onboardingDone=false;
let _fetchController=null;
let _thinkTimer=null, _thinkPhaseIdx=0;

/* ── THOUGHT SYSTEM STATE ── */
let _thoughts=[];
let _thoughtEls=[];
let _currentThoughtIdx=-1;
let _statusBox=null;

/* ════════════════════════════════════════════════════════
   DYNAMIC THOUGHT GENERATION
   Instead of hardcoded scripts, we ask the model to plan
   its own reasoning steps for each specific message.
   ════════════════════════════════════════════════════════ */

/**
 * Generate contextual thought steps for this specific user message.
 * Makes a fast, cheap API call that returns a JSON array of steps.
 * Falls back to sensible defaults if the call fails or times out.
 */
async function generateThoughtSteps(userMessage, model, conversationContext) {
  const systemPrompt = `You are a reasoning planner. Given a user message, produce a JSON array of 3-6 concise reasoning steps that an AI would actually work through to answer it well. Each step has a "title" (2-4 words, title case) and "body" (1 sentence describing what's being done). Be specific to THIS message — don't use generic steps.

Calibrate depth to the message:
- Simple/factual → 3 steps, concise
- Complex/analytical → 5-6 steps, substantive  
- Creative → 4-5 steps focused on craft choices
- Code/technical → 4-5 steps covering understanding, planning, implementation

Return ONLY valid JSON array, no markdown, no preamble. Example:
[{"title":"Parsing the Question","body":"Identifying what kind of comparison is being asked and what criteria matter most."},{"title":"Retrieving Knowledge","body":"Pulling together relevant facts about both subjects from memory."}]`;

  const contextSnippet = conversationContext
    ? conversationContext.slice(-3).map(m => `${m.role}: ${(m.message||'').slice(0,120)}`).join('\n')
    : '';

  const userContent = contextSnippet
    ? `Recent context:\n${contextSnippet}\n\nNew message: ${userMessage.slice(0, 300)}`
    : `Message: ${userMessage.slice(0, 300)}`;

  // Race against a timeout — if slow, use fallback immediately
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 4000)
  );

  const fetchPromise = (async () => {
    const res = await fetch(CLOAK_API + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'pneuma', // always use fast model for step generation
        messages: [
          { role: 'user', content: userContent }
        ],
        system: systemPrompt,
        max_tokens: 400,
      }),
    });
    if (!res.ok) throw new Error('step-gen failed');
    const data = await res.json();
    const raw = data.response || data.text || '';
    // Strip any accidental markdown fences
    const clean = raw.replace(/```json|```/gi, '').trim();
    const steps = JSON.parse(clean);
    if (!Array.isArray(steps) || !steps.length) throw new Error('bad shape');
    // Validate and clamp
    return steps.slice(0, 6).map(s => ({
      title: String(s.title || 'Processing').slice(0, 40),
      body:  String(s.body  || '').slice(0, 140),
    }));
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch (e) {
    log('inf', 'Thought gen fallback: ' + e.message);
    return _fallbackSteps(userMessage, model);
  }
}

/**
 * Fallback steps when API call fails/times out.
 * Still tries to be somewhat contextual based on message content.
 */
function _fallbackSteps(message, model) {
  const msg = (message || '').toLowerCase();

  if (/\b(code|function|bug|error|debug|script|class|api|sql|python|javascript|css|html)\b/.test(msg)) {
    return [
      { title: 'Reading the Code', body: 'Parsing the structure, logic, and intent of what was written.' },
      { title: 'Spotting Issues', body: 'Identifying bugs, inefficiencies, or gaps in the implementation.' },
      { title: 'Planning the Fix', body: 'Deciding on the cleanest approach that solves the problem.' },
      { title: 'Writing the Solution', body: 'Generating corrected or improved code with clear explanations.' },
    ];
  }
  if (/\b(write|draft|essay|email|letter|story|poem|blog|article|describe)\b/.test(msg)) {
    return [
      { title: 'Setting the Tone', body: 'Calibrating voice and register for the context and audience.' },
      { title: 'Finding the Angle', body: 'Choosing the framing that makes this piece memorable.' },
      { title: 'Structuring the Piece', body: 'Laying out what comes first, what builds, what lands the ending.' },
      { title: 'Drafting', body: 'Generating content with attention to rhythm and specificity.' },
      { title: 'Refining', body: 'Cutting what is weak and elevating what is strong.' },
    ];
  }
  if (/\b(explain|how does|what is|why|difference|compare|vs|versus)\b/.test(msg)) {
    return [
      { title: 'Parsing the Question', body: 'Clarifying exactly what is being asked and what level of depth fits.' },
      { title: 'Retrieving Context', body: 'Pulling relevant knowledge and framing the right conceptual lens.' },
      { title: 'Building the Explanation', body: 'Structuring a clear, logical answer with useful examples.' },
    ];
  }
  if (model === 'logos') {
    return [
      { title: 'Decomposing the Problem', body: 'Breaking into sub-questions and identifying what must be resolved first.' },
      { title: 'Exploring Approaches', body: 'Considering multiple ways to tackle this and weighing their trade-offs.' },
      { title: 'Stress-Testing', body: 'Checking for edge cases, contradictions, or gaps in the reasoning.' },
      { title: 'Synthesizing', body: 'Integrating the best approach into a well-reasoned answer.' },
    ];
  }
  // Generic default
  return [
    { title: 'Reading Carefully', body: 'Making sure I fully understand what is being asked before proceeding.' },
    { title: 'Gathering Context', body: 'Drawing on relevant knowledge and the conversation so far.' },
    { title: 'Forming a Response', body: 'Deciding on structure, depth, and the best way to present this.' },
  ];
}

/** Should thoughts run for this model/mode? */
function _shouldThink(model) {
  return model === 'logos' || model === 'kairos' || thinkModeActive;
}

/**
 * Timing between thought steps (ms). Logos gets more time to feel deliberate.
 */
function _thoughtDelay(model, stepIndex) {
  const base = {
    logos:  [1600, 3000, 4800, 6800, 9000, 11000],
    kairos: [1300, 2700, 4200, 6000, 8000, 10000],
    pneuma: [1000, 2200, 3600, 5200, 7000, 9000],
  }[model] || [1200, 2600, 4200, 6000, 8000, 10000];
  return base[stepIndex] || base[base.length - 1];
}

/* Voice Mode Variables */
let voiceMode = false;
let voiceState = 'idle';
let asciiInterval = null;
let asciiFrame = 0;
let recognition = null;
let synth = window.speechSynthesis;

if(dark)document.body.classList.add('dark');

let _domReady=document.readyState!=='loading';
function whenDomReady(){
  if(_domReady)return Promise.resolve();
  return new Promise(resolve=>{
    document.addEventListener('DOMContentLoaded',()=>{_domReady=true;resolve();},{once:true});
  });
}

/* ── CONFIG ── */
async function loadAppConfig() {
  try {
    const { data } = await sb.from('app_config').select('value').eq('key', 'model_list').single();
    if (data && data.value) log('inf', 'Config loaded');
  } catch(e) { log('err', 'Config load failed: ' + e.message); }
}

/* ── THEME ── */
function setTheme(t){
  hapticTap();
  currentTheme=t;localStorage.setItem('cloak_theme',t);
  document.documentElement.setAttribute('data-theme',t);
  document.querySelectorAll('.theme-card').forEach(el=>el.classList.toggle('active',el.id==='theme-'+t));
  syncThemeColor();
}
function initThemeUI(){document.querySelectorAll('.theme-card').forEach(el=>el.classList.toggle('active',el.id==='theme-'+currentTheme));}

/* ── HAPTICS ──
   navigator.vibrate works on Android; iOS Safari ignores it (no-op). Wrapped so
   it never throws. iOS true haptics aren't exposed to the web, so we degrade
   gracefully rather than faking it. */
function hapticTap(){ try{ if(navigator.vibrate) navigator.vibrate(8); }catch(_){ } }
function hapticImpact(){ try{ if(navigator.vibrate) navigator.vibrate([14]); }catch(_){ } }
function hapticError(){ try{ if(navigator.vibrate) navigator.vibrate([18,40,18]); }catch(_){ } }

/* ── STATUS-BAR / THEME-COLOR SYNC ──
   Keep <meta name=theme-color> matching the active theme's paper so the iOS
   standalone status bar and Android address bar tint track light/dark + theme. */
function syncThemeColor(){
  try{
    let c=getComputedStyle(document.body).getPropertyValue('--paper').trim();
    if(!c) c=dark?'#131110':'#F2EEE5';
    let m=document.querySelector('meta[name="theme-color"]');
    if(!m){ m=document.createElement('meta'); m.name='theme-color'; document.head.appendChild(m); }
    m.setAttribute('content', c);
  }catch(_){ }
}

/* ── AUDIO PRIMING (iOS) ──
   iOS blocks AudioContext / speechSynthesis until a user gesture. Prime once on
   the first pointer interaction so voice mode can speak later. */
let _audioPrimed=false;
function primeAudio(){
  if(_audioPrimed) return; _audioPrimed=true;
  try{ const Ctx=window.AudioContext||window.webkitAudioContext;
    if(Ctx){ window._actx=window._actx||new Ctx(); if(window._actx.state==='suspended') window._actx.resume(); } }catch(_){ }
  try{ if(synth){ const u=new SpeechSynthesisUtterance(''); u.volume=0; synth.speak(u); } }catch(_){ }
}
document.addEventListener('pointerdown', primeAudio, {once:true});

/* ── VIEWPORT FIX ── */
(function(){
  function applyVV(){var el=document.getElementById('s-chat');if(!el||!el.classList.contains('active'))return;var vv=window.visualViewport;if(vv){el.style.top=vv.offsetTop+'px';el.style.left=vv.offsetLeft+'px';el.style.width=vv.width+'px';el.style.height=vv.height+'px';}else{el.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0';}}
  if(window.visualViewport){window.visualViewport.addEventListener('resize',applyVV);window.visualViewport.addEventListener('scroll',applyVV);}
  window.addEventListener('resize',applyVV);window._vv=applyVV;
})();

/* ── MARKED / SYNTAX ── */
function hesc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function syntaxHL(code,lang){
  var out=hesc(code);
  var kw={js:['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','delete','typeof','instanceof','in','of','import','export','default','class','extends','super','this','async','await','try','catch','finally','throw','from','null','undefined','true','false','void'],py:['def','class','return','if','elif','else','for','while','import','from','as','with','try','except','finally','raise','and','or','not','in','is','None','True','False','lambda','pass','break','continue','yield','async','await'],sql:['SELECT','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','ON','GROUP','ORDER','BY','HAVING','INSERT','UPDATE','DELETE','CREATE','ALTER','DROP','TABLE','VALUES','SET','AS','AND','OR','NOT','IN','LIKE','BETWEEN','NULL','IS','COUNT','SUM','AVG','MAX','MIN','DISTINCT']};
  var l={js:kw.js,javascript:kw.js,ts:kw.js,typescript:kw.js,py:kw.py,python:kw.py,sql:kw.sql}[lang];
  out=out.replace(/(&#x27;[^&#x27;]*&#x27;|&quot;[^&quot;]*&quot;)/g,'<span class="str">$1</span>');
  out=out.replace(/(\/\/[^\n]*)/g,'<span class="cmt">$1</span>');
  out=out.replace(/(#[^\n]*)/g,'<span class="cmt">$1</span>');
  out=out.replace(/\b(\d+\.?\d*)\b/g,'<span class="num">$1</span>');
  if(l)l.forEach(function(k){out=out.replace(new RegExp('\\b('+k+')\\b','g'),'<span class="kw">$1</span>');});
  return out;
}
const rend=new marked.Renderer();
rend.code=(code,lang)=>{
  const dl=lang||'text';const id='c'+Math.random().toString(36).slice(2,8);const hl=syntaxHL(code,lang);
  return '<pre><div class="code-bar"><span class="code-lang">'+hesc(dl)+'<\/span><div class="code-actions"><button class="code-btn" onclick="cpCode(\''+id+'\',this)">Copy<\/button><\/div><\/div><code id="'+id+'">'+hl+'<\/code><\/pre>';
};
rend.link=(href,title,text)=>{
  const safe=hesc(href||'');const t=title?'title="'+hesc(title)+'"':'';
  if (/^\[?\d+\]?$/.test(text)) {
    const num = text.replace(/[\[\]]/g, '');
    return '<a href="#" class="cit-bubble" '+t+' onclick="interceptLink(event,\''+safe+'\')">'+num+'</a>';
  }
  return '<a href="#" class="ext-link" '+t+' onclick="interceptLink(event,\''+safe+'\')">'+text+'</a>';
};
marked.use({renderer:rend,mangle:false,headerIds:false});

/* ════════════════════════════════════════════════════════
   THOUGHT UI SYSTEM
   Renders dynamic steps as they're generated/completed.
   Each step shows: spinner → checkmark when done.
   ════════════════════════════════════════════════════════ */

let _thoughtLog = [];
let _thoughtChainEl = null;
let _thoughtCurrentEl = null;
let _thoughtHistoryEl = null;
let _thoughtExpandBtn = null;
let _thoughtStartTime = 0;
let _thoughtTickInterval = null;

/**
 * Build the step-list UI inside the bot message.
 * Matches the step-list-wrap / step-list-inner CSS already in cloak.css.
 */
function createThoughtChain(botMsgEl) {
  const botBody = botMsgEl.querySelector('.bot-body');
  if (!botBody) return null;
  const existing = botBody.querySelector('.thought-chain');
  if (existing) existing.remove();

  _thoughtLog = [];

  // Outer wrapper — uses existing .step-list-wrap styles
  const wrap = document.createElement('div');
  wrap.className = 'step-list-wrap thought-chain';

  // Header
  const header = document.createElement('div');
  header.className = 'step-list-header';
  header.innerHTML = `
    <div class="step-list-header-left">
      <span class="step-header-dot" id="thought-pulse-dot"></span>
      <span class="step-header-label">Thinking</span>
    </div>
    <button class="step-collapse-btn rotated" id="thought-collapse-btn" title="Collapse">
      <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
        <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>`;
  wrap.appendChild(header);

  // Collapsible inner list
  const inner = document.createElement('div');
  inner.className = 'step-list-inner';
  inner.id = 'thought-step-list';
  wrap.appendChild(inner);

  // Wire up collapse
  header.querySelector('#thought-collapse-btn').addEventListener('click', () => {
    const btn = header.querySelector('#thought-collapse-btn');
    inner.classList.toggle('collapsed');
    btn.classList.toggle('rotated');
  });

  botBody.insertBefore(wrap, botBody.querySelector('.bot-content'));

  _thoughtChainEl = wrap;
  _thoughtCurrentEl = inner;
  _thoughtStartTime = Date.now();

  // Live elapsed-time tick (Perplexity-style)
  if (_thoughtTickInterval) clearInterval(_thoughtTickInterval);
  const labelEl = wrap.querySelector('.step-header-label');
  _thoughtTickInterval = setInterval(() => {
    if (!labelEl || !_thoughtStartTime) return;
    const s = Math.floor((Date.now() - _thoughtStartTime) / 1000);
    labelEl.textContent = s > 0 ? `Thinking · ${s}s` : 'Thinking';
  }, 500);

  return wrap;
}

/**
 * Add a step row to the list. Returns the DOM element.
 * Starts in "active" state (spinner). Call completeStep() to check it off.
 */
function addThoughtStep(title, body) {
  const inner = document.getElementById('thought-step-list');
  if (!inner) return null;

  _thoughtLog.push({ title, body });
  const idx = _thoughtLog.length - 1;

  const row = document.createElement('div');
  row.className = 'step-row step-row-entering';
  row.id = 'thought-step-' + idx;

  row.innerHTML = `
    <div class="step-icon">
      <svg class="step-spinner" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--acc)" stroke-width="2" stroke-linecap="round">
        <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.93 2.93l1.41 1.41M9.66 9.66l1.41 1.41M2.93 11.07l1.41-1.41M9.66 4.34l1.41-1.41"/>
      </svg>
    </div>
    <div class="step-text">
      <div class="step-title step-title-active">${hesc(title)}</div>
      <div class="step-body">${hesc(body)}</div>
    </div>`;

  inner.appendChild(row);

  // Animate in
  requestAnimationFrame(() => {
    row.classList.remove('step-row-entering');
    row.classList.add('step-row-visible');
  });

  scrollBottom();
  return row;
}

/**
 * Mark a step as done — swap spinner for checkmark, fade text.
 */
function completeThoughtStep(idx) {
  const row = document.getElementById('thought-step-' + idx);
  if (!row) return;

  const icon = row.querySelector('.step-icon');
  const title = row.querySelector('.step-title');
  const body = row.querySelector('.step-body');

  if (icon) {
    icon.innerHTML = `
      <svg class="step-check step-icon-done" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--acc)" stroke-width="2" stroke-linecap="round">
        <path d="M2 7l3.5 3.5L12 3"/>
      </svg>`;
  }
  if (title) { title.classList.remove('step-title-active'); title.classList.add('step-title-done'); }
  if (body)  { body.classList.add('step-body-done'); }
}

/**
 * Called when the actual response starts arriving.
 * Completes any remaining active steps, stops animations.
 */
function finaliseThoughts(botMsgEl) {
  // Stop the live tick
  if (_thoughtTickInterval) { clearInterval(_thoughtTickInterval); _thoughtTickInterval = null; }

  // Complete all unchecked steps
  _thoughtLog.forEach((_, i) => completeThoughtStep(i));

  // Stop the pulsing dot in the header
  const pulseDot = document.getElementById('thought-pulse-dot');
  if (pulseDot) pulseDot.classList.add('step-header-dot-done');
  const header = _thoughtChainEl?.querySelector('.step-list-header');
  if (header) header.classList.add('done');

  // Update header label with elapsed time
  const label = _thoughtChainEl?.querySelector('.step-header-label');
  if (label) {
    const elapsed = _thoughtStartTime ? Math.max(1, Math.round((Date.now() - _thoughtStartTime) / 1000)) : 0;
    label.textContent = elapsed ? `Thought for ${elapsed}s` : 'Thought for a moment';
  }
  _thoughtStartTime = 0;

  // Auto-collapse the step list after a brief delay
  setTimeout(() => {
    const inner = document.getElementById('thought-step-list');
    const btn = document.getElementById('thought-collapse-btn');
    if (inner && !inner.classList.contains('collapsed')) {
      inner.classList.add('collapsed');
      if (btn) btn.classList.remove('rotated');
    }
  }, 900);
}

/* ════════════════════════════════════════════════════════
   THOUGHT SEQUENCE RUNNER
   Generates steps dynamically, then animates them in sync
   with the actual fetch so timing feels natural.
   ════════════════════════════════════════════════════════ */

async function runThoughtSequence(botMsgEl, model, userMessage, responsePromise) {
  // 1. Start generating steps (fast pre-call) in parallel with main fetch
  const stepsPromise = generateThoughtSteps(userMessage, model, hist);

  // 2. Build the UI shell immediately
  createThoughtChain(botMsgEl);

  // Show a "planning..." placeholder while steps are generated
  let placeholderRow = addThoughtStep('Planning', 'Working out how to approach this…');

  let steps;
  try {
    steps = await stepsPromise;
  } catch (e) {
    steps = _fallbackSteps(userMessage, model);
  }

  // Smoothly fade out the placeholder, then inject real steps
  if (placeholderRow) {
    placeholderRow.classList.add('step-row-exiting');
    await sleep(180);
    _thoughtLog = []; // reset so real steps index from 0
    const inner = document.getElementById('thought-step-list');
    if (inner) inner.innerHTML = '';
  }

  let responseReady = false;
  responsePromise.then(() => { responseReady = true; }).catch(() => { responseReady = true; });

  // 3. Animate through each step with realistic timing
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    addThoughtStep(step.title, step.body);

    // Mark previous step done
    if (i > 0) completeThoughtStep(i - 1);

    const delay = _thoughtDelay(model, i);

    // Wait for delay OR response arriving — whichever comes first
    await Promise.race([
      sleep(delay),
      new Promise(r => {
        const iv = setInterval(() => {
          if (responseReady) { clearInterval(iv); r(); }
        }, 60);
      }),
    ]);

    if (responseReady) break;
  }
}

function stopThinkAnimation() {
  if (_thinkTimer) { clearTimeout(_thinkTimer); _thinkTimer = null; }
}

function stopStream(){
  if(_fetchController){_fetchController.abort();_fetchController=null;}
}

/* ── POST-PROCESS BOT MESSAGE ── */
function postProcessBotEl(msgEl, rawText){
  if(!msgEl||msgEl.querySelector('.msg-actions'))return;
  const botBody=msgEl.querySelector('.bot-body');if(!botBody)return;
  const actions=document.createElement('div');
  actions.className='msg-actions';
  const copyBtn=document.createElement('button');
  copyBtn.className='msg-action-btn';
  copyBtn.title='Copy response';
  copyBtn.innerHTML='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copyBtn.addEventListener('click',()=>{
    const txt=rawText||(msgEl.querySelector('.bot-content')?.innerText||'');
    navigator.clipboard.writeText(txt).then(()=>{
      copyBtn.classList.add('copied');
      copyBtn.innerHTML='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';
      setTimeout(()=>{copyBtn.classList.remove('copied');copyBtn.innerHTML='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';},1600);
    }).catch(()=>{});
  });
  actions.appendChild(copyBtn);
  botBody.appendChild(actions);
}

/* ── FOCUS VIEW ──
   The latest user message pins to the top of the chat: the reply after it
   gets a min-height filling the rest of the view, so scrolling down stops
   there. Older messages stay scrollable above. */
function trimToLatest(scroll=true){
  const box=document.getElementById('messages'),ca=document.getElementById('chat-area');
  if(!box||!ca)return;
  const users=box.querySelectorAll('.msg.user'),user=users[users.length-1];
  if(!user){box.style.paddingBottom='';return;}
  // Spacer so the max scroll lands exactly with the latest user message at top.
  const pin=user.offsetTop-box.offsetTop-8;
  const last=box.lastElementChild;
  const contentEnd=last.offsetTop-box.offsetTop+last.offsetHeight;
  box.style.paddingBottom=Math.max(40,pin+ca.clientHeight-contentEnd)+'px';
  if(scroll)ca.scrollTop=pin;
}
(function(){
  const box=document.getElementById('messages');
  if(box&&'ResizeObserver' in window){
    let raf=0;
    new ResizeObserver(()=>{if(!raf)raf=requestAnimationFrame(()=>{raf=0;trimToLatest(false);});}).observe(box);
    window.addEventListener('resize',()=>trimToLatest(false));
  }
})();

/* ── ADD MESSAGE ── */
function addMsg(role,content,noAnim=false,imgs=[]){
  const box=document.getElementById('messages');
  const d=document.createElement('div');
  d.className='msg '+(role==='user'?'user':'bot');
  if(role==='user'){
    let imgHtml='';
    if(imgs.length){
      imgHtml='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">';
      imgs.forEach(img=>{imgHtml+='<img src="'+img.data+'" style="width:80px;height:80px;object-fit:cover;border:2px solid var(--ink)" alt="img">';});
      imgHtml+='</div>';
    }
    d.innerHTML='<div class="msg-wrap"><div class="bubble">'+imgHtml+(content?'<div>'+hesc(content)+'</div>':'')+'</div></div>';
    if(content)d.dataset.raw=content;
    const actions=document.createElement('div');
    actions.className='msg-actions user-msg-actions';
    const editBtn=document.createElement('button');
    editBtn.className='msg-action-btn';
    editBtn.title='Edit message';
    editBtn.innerHTML='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    editBtn.addEventListener('click',()=>editMessage(d));
    actions.appendChild(editBtn);
    const wrap=d.querySelector('.msg-wrap');if(wrap)wrap.appendChild(actions);
  }else{
    const html=noAnim?marked.parse(content):'';
    d.innerHTML='<div class="bot-body"><div class="bot-meta">'+CLOAK_ORB_HTML+'<span class="bot-label">Cloak</span></div><div class="bot-content">'+html+'</div></div>';
    if(noAnim){restOrbBelow(d);postProcessBotEl(d,content);}
  }
  box.appendChild(d);if(role==='user')trimToLatest();scrollBottom(role==='user');return d;
}

function editMessage(msgEl){
  if(busy)return;
  const rawText=msgEl.dataset.raw||'';
  const box=document.getElementById('messages');
  const msgs=Array.from(box.children);
  const idx=msgs.indexOf(msgEl);
  if(idx===-1)return;
  const removed=msgs.slice(idx);
  removed.forEach(el=>el.remove());
  const toRemove=removed.length;
  hist=hist.slice(0,Math.max(0,hist.length-toRemove));
  if(window.CloakContext)CloakContext.truncate(hist.length);
  trimToLatest();
  const inp=document.getElementById('chat-input');
  inp.value=rawText;inp.focus();onInput(inp);
  if(!hist.length){document.getElementById('messages').style.display='none';document.getElementById('empty-state').style.display='flex';}
}

function showMessages(){document.getElementById('empty-state').style.display='none';document.getElementById('messages').style.display='flex';}

/* Scroll-aware bottom snap — don't fight the user when they scroll up */
let _userScrolledUp=false;
let _scrollListenerInit=false;
function _initScrollListener(){
  if(_scrollListenerInit)return;
  const ca=document.getElementById('chat-area');
  if(!ca)return;
  _scrollListenerInit=true;
  ca.addEventListener('scroll',()=>{
    const dist=ca.scrollHeight-ca.scrollTop-ca.clientHeight;
    _userScrolledUp=dist>140;
  },{passive:true});
}
function scrollBottom(force){
  const ca=document.getElementById('chat-area');
  if(!ca)return;
  _initScrollListener();
  if(force){_userScrolledUp=false;}
  if(_userScrolledUp)return;
  ca.scrollTop=ca.scrollHeight;
}
function onInput(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,160)+'px';if(!busy)document.getElementById('send-btn').disabled=!el.value.trim();setOrbState(document.getElementById('welcome-orb'),el.value.trim()?'listening':null);}
function onKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!document.getElementById('send-btn').disabled&&!busy)send();else if(busy){stopStream();}}}
function showE(el,msg){el.textContent=msg;el.classList.add('show');}
function clearE(id){const el=document.getElementById(id);if(el){el.textContent='';el.classList.remove('show');}}

/* ── VOICE MODE ── */
function initVoice() {
  const SpRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpRec) return false;
  recognition = new SpRec();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    if(voiceMode && voiceState !== 'thinking' && voiceState !== 'speaking') voiceState = 'listening';
  };
  recognition.onresult = (e) => {
    let interim = ''; let final = '';
    for(let i=e.resultIndex; i<e.results.length; ++i) {
      if(e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    document.getElementById('voice-transcript').textContent = final || interim;
    if(final) { document.getElementById('chat-input').value = final; send(); }
  };
  recognition.onend = () => {
    if(voiceMode && voiceState === 'idle') { try { recognition.start(); } catch(e){} }
  };
  return true;
}

function startVoiceMode() {
  if(!recognition) {
    const supported = initVoice();
    if(!supported) { alert("Voice dictation is not supported in your browser."); return; }
  }
  voiceMode = true; voiceState = 'idle';
  document.getElementById('voice-overlay').classList.add('active');
  document.getElementById('voice-transcript').textContent = 'Listening...';
  startAsciiAnim();
  try { recognition.start(); } catch(e){}
}

function stopVoiceMode() {
  voiceMode = false;
  document.getElementById('voice-overlay').classList.remove('active');
  stopAsciiAnim();
  if(recognition) recognition.stop();
  synth.cancel();
}

function startAsciiAnim() {
  if(asciiInterval) clearInterval(asciiInterval);
  asciiInterval = setInterval(() => {
    asciiFrame++;
    let art = "", stat = "";
    if(voiceState === 'listening') {
      const frames = ["[ = - - - - - ]","[ - = - - - - ]","[ - - = - - - ]","[ - - - = - - ]","[ - - - - = - ]","[ - - - - - = ]","[ - - - - = - ]","[ - - - = - - ]","[ - - = - - - ]","[ - = - - - - ]"];
      art = frames[asciiFrame % frames.length]; stat = "Listening";
    } else if(voiceState === 'thinking') {
      const frames = ["[ .           ]","[ . .         ]","[ . . .       ]","[ . . . .     ]","[ . . . . .   ]","[ . . . . . . ]","[   . . . . . ]","[     . . . . ]","[       . . . ]","[         . . ]","[           . ]","[             ]"];
      art = frames[asciiFrame % frames.length]; stat = "Thinking";
    } else if(voiceState === 'speaking') {
      const frames = ["[ | | | | | | ]","[ / / / / / / ]","[ - - - - - - ]","[ \\ \\ \\ \\ \\ \\ ]"];
      art = frames[asciiFrame % frames.length]; stat = "Speaking";
    } else {
      art = "[ - - - - - - ]"; stat = "Idle";
    }
    document.getElementById('voice-ascii').textContent = art;
    document.getElementById('voice-status').textContent = stat;
  }, 150);
}

function stopAsciiAnim() { clearInterval(asciiInterval); }
function stripMD(text) { return text.replace(/[#*`_~]/g, '').replace(/\[.*?\]\(.*?\)/g, '').trim(); }

function playVoice(text) {
  if(recognition) recognition.stop();
  voiceState = 'speaking';
  const u = new SpeechSynthesisUtterance(stripMD(text));
  u.onend = () => {
    if(!voiceMode) return;
    voiceState = 'idle';
    document.getElementById('voice-transcript').textContent = 'Listening...';
    try { recognition.start(); } catch(e){}
  };
  u.onerror = () => {
    if(!voiceMode) return;
    voiceState = 'idle';
    try { recognition.start(); } catch(e){}
  };
  synth.speak(u);
}

function renderConvs(){
  const list=document.getElementById('conv-list');list.innerHTML='';
  convs.forEach(c=>{
    const d=document.createElement('div');d.className='conv-item'+(c.id===chatId?' active':'');
    const lbl=document.createElement('div');lbl.className='conv-label';
    lbl.innerHTML='<svg class="conv-icon" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>'+hesc(c.title)+'</span>';
    lbl.title=c.title;lbl.onclick=()=>loadConv(c.id);
    const del=document.createElement('button');del.className='conv-del';del.title='Delete';
    del.innerHTML='<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
    del.onclick=e=>{e.stopPropagation();delConv(c.id);};d.appendChild(lbl);d.appendChild(del);list.appendChild(d);
  });
}

function newChat(){
  if(hist.length)_greetAfterChat=true;
  if(window.CloakMemory)CloakMemory.flush();
  if(window.CloakContext)CloakContext.reset();
  chatId=null;hist=[];document.getElementById('messages').innerHTML='';
  document.getElementById('messages').style.display='none';document.getElementById('empty-state').style.display='flex';renderConvs();updateGreeting();
}
function cpCode(id,btn){navigator.clipboard.writeText(document.getElementById(id)?.innerText||'').then(()=>{btn.textContent='Copied!';btn.classList.add('ok');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('ok');},1400);});}

/* ── BUSY STATE ── */
function setBusy(b){
  busy=b;
  const btn=document.getElementById('send-btn');
  const inp=document.getElementById('chat-input');
  if(b){
    btn.disabled=false;btn.classList.add('stop-mode');
    btn.innerHTML='<svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><rect x="1" y="1" width="9" height="9" rx="1.5"/></svg>';
    btn.onclick=stopStream;btn.title='Stop';
  }else{
    btn.classList.remove('stop-mode');
    btn.innerHTML='<svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z"/></svg>';
    btn.onclick=send;btn.title='Send';
    btn.disabled=!inp.value.trim();
  }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

/* ── INSERT BOT BUBBLE ── */
/* ── CLOAK ORB ──
   The little indicator next to the "Cloak" label. Default state is a circle
   with the neobrutalist ink outline (the "orb"). It's interactive: click it
   and it bounces like a squishy button and pops a speech bubble. While Cloak
   is thinking, createCloakStatus() swaps it for the morphing glyph. */
const CLOAK_ORB_HTML =
  '<span class="bot-dot cloak-orb" role="button" tabindex="0" aria-label="Say hi to Cloak">' +
  '<svg viewBox="-52 -52 104 104" aria-hidden="true"><circle class="cs-shape" cx="0" cy="0" r="46"></circle></svg>' +
  '</span>';

function _orbBounce(orb){
  orb.classList.remove('orb-bounce');
  void orb.offsetWidth;            // reflow so the animation can restart
  orb.classList.add('orb-bounce');
}

function _orbSpeak(orb){
  const existing = orb.querySelector('.orb-bubble');
  if(existing){                     // already open → toggle it closed
    existing.classList.remove('show');
    clearTimeout(orb._bubbleT);
    setTimeout(()=>existing.remove(), 280);
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = 'orb-bubble';
  bubble.textContent = "Hey! I'm Cloak, how can I help?";
  orb.appendChild(bubble);
  requestAnimationFrame(()=>bubble.classList.add('show'));
  clearTimeout(orb._bubbleT);
  orb._bubbleT = setTimeout(()=>{
    bubble.classList.remove('show');
    setTimeout(()=>{ if(bubble.parentNode) bubble.remove(); }, 300);
  }, 3400);
}

function _orbActivate(orb){ hapticTap(); _orbBounce(orb); _orbSpeak(orb); }

// One delegated listener handles every orb on the page (current + future).
document.addEventListener('click', (e)=>{
  const orb = e.target.closest && e.target.closest('.cloak-orb');
  if(orb){ e.stopPropagation(); _orbActivate(orb); }
});
document.addEventListener('keydown', (e)=>{
  if(e.key!=='Enter' && e.key!==' ') return;
  const orb = e.target.closest && e.target.closest('.cloak-orb');
  if(orb){ e.preventDefault(); _orbActivate(orb); }
});

function insertBotBubble() {
  const from = _takeRestingOrb();
  const box = document.getElementById('messages');
  showMessages();
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML = '<div class="bot-body"><div class="bot-meta">'+CLOAK_ORB_HTML+'<span class="bot-label">Cloak</span></div><div class="bot-content"><div class="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div></div>';
  box.appendChild(wrap);
  trimToLatest();
  travelOrb(from, wrap);
  return wrap;
}

function insertBotBubbleForThoughts() {
  const from = _takeRestingOrb();
  const box = document.getElementById('messages');
  showMessages();
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML = '<div class="bot-body"><div class="bot-meta">'+CLOAK_ORB_HTML+'<span class="bot-label">Cloak</span></div><div class="bot-content"></div></div>';
  box.appendChild(wrap);
  trimToLatest();
  travelOrb(from, wrap);
  return wrap;
}

function replaceThinkWithContent(botMsgEl, rawText) {
  stopThinkAnimation();
  finaliseThoughts(botMsgEl);

  const bc = botMsgEl.querySelector('.bot-content');
  if (!bc) return;

  // No fake typewriter — text only animates in from live token streaming.
  if (botMsgEl._status) { botMsgEl._status.destroy(); botMsgEl._status = null; }
  dropTailOrb(botMsgEl);
  finishStatus(botMsgEl);
  bc.innerHTML = marked.parse(rawText);
  postProcessBotEl(botMsgEl, rawText);
  setBotState(botMsgEl, null);
  restOrbBelow(botMsgEl, /^Error:/.test(rawText) ? 'error' : 'done');
  setBusy(false);
  scrollBottom();
}

/* ════════════════════════════════════════════════════════
   CLOAK STATUS — high-fidelity morphing-shape thinking glyph
   On send, a large on-brand glyph pops up and cycles through
   triangle → circle → square, pulsing as it morphs. Once the
   model starts working it tweens smaller and docks inline,
   updating its status label as the bot does different things.
   ════════════════════════════════════════════════════════ */

function _csEaseInOut(x){ return x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x+2,3)/2; }

// Resample a closed polyline into N equally arc-spaced points.
function _csResample(loop, N){
  const segs=[]; let total=0;
  for(let i=0;i<loop.length-1;i++){
    const len=Math.hypot(loop[i+1][0]-loop[i][0], loop[i+1][1]-loop[i][1]);
    segs.push(len); total+=len;
  }
  const out=[], step=total/N; let target=0, si=0, acc=0;
  for(let i=0;i<N;i++){
    while(si<segs.length-1 && acc+segs[si]<target){ acc+=segs[si]; si++; }
    const segLen=segs[si]||1e-6, f=(target-acc)/segLen;
    const a=loop[si], b=loop[si+1];
    out.push([a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f]);
    target+=step;
  }
  return out;
}

// Unit-radius shape sampled to N points, all starting at top, going clockwise.
function _csShape(kind, N){
  if(kind==='circle'){
    const p=[];
    for(let i=0;i<N;i++){ const a=-Math.PI/2 + 2*Math.PI*i/N; p.push([Math.cos(a), Math.sin(a)]); }
    return p;
  }
  if(kind==='square') return _csResample([[0,-0.94],[0.94,-0.94],[0.94,0.94],[-0.94,0.94],[-0.94,-0.94],[0,-0.94]], N);
  // triangle, pointing up
  return _csResample([[0,-1.12],[0.99,0.64],[-0.99,0.64],[0,-1.12]], N);
}

/* ── ORB STATE MACHINE ──
   The orb acts out the current step (see ORB STATES in cloak.css):
   thinking → squish · searching → scan · streaming → hop · done → settle ·
   error → shake · listening → perk. null = rest. */
const ORB_STATES=['thinking','searching','streaming','done','error','listening'];
const BOT_STATE_LABELS={thinking:'Cloak is thinking…',searching:'Cloak is searching…'};

function setOrbState(orb, state){
  if(!orb) return;
  const cur=orb.dataset.state||null;
  if(cur===state && state!=='done' && state!=='error') return; // don't restart a running loop
  clearTimeout(orb._stateT);
  orbGlobe(orb, state==='searching');
  ORB_STATES.forEach(k=>orb.classList.remove('orb-'+k));
  if(!state){ delete orb.dataset.state; return; }
  void orb.offsetWidth;            // reflow so one-shot animations can replay
  orb.classList.add('orb-'+state);
  orb.dataset.state=state;
  if(state==='done'||state==='error'){
    orb._stateT=setTimeout(()=>setOrbState(orb,null), state==='done'?650:500);
  }
}

/* ── SEARCHING GLOBE ──
   While searching, meridians spin in over the orb's left edge and the equator
   is drawn in behind the first one. When searching stops no new meridians come
   round: the ones on the face finish their pass off the right edge and the
   equator is wiped behind the last one, leaving the plain orb. */
function orbGlobe(orb, on){
  let g=orb._globe;
  if(!g){
    if(!on) return;
    const svg=orb.querySelector('svg'); if(!svg) return;
    const NS='http://www.w3.org/2000/svg', R=46, N=4, TAU=Math.PI*2;
    const mk=(t,p,a)=>{const e=document.createElementNS(NS,t);for(const k in a)e.setAttribute(k,a[k]);p.appendChild(e);return e;};
    const id='og'+Math.random().toString(36).slice(2,8);
    mk('circle',mk('clipPath',mk('defs',svg,{}),{id}),{r:R-1});
    const grp=mk('g',svg,{class:'orb-globe','clip-path':'url(#'+id+')'});
    mk('circle',svg,{r:R,class:'orb-globe-ring'});    // ink outline redrawn over the lines
    g=orb._globe={on:false,th:0,spin:0,raf:0,last:0,fill:'empty',lead:-1,drain:false,
      eq:mk('line',grp,{y1:0,y2:0}),mer:Array.from({length:N},()=>mk('path',grp,{}))};
    const ang=i=>g.th+i*TAU/N, front=i=>Math.cos(ang(i))>0;
    g.alive=g.mer.map(()=>false); g.was=g.mer.map((_,i)=>front(i));
    const vis=()=>g.mer.map((_,i)=>i).filter(i=>g.alive[i]&&front(i));
    const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    g.render=()=>{
      const v=vis(), sn=i=>Math.sin(ang(i));
      g.mer.forEach((p,i)=>{ if(!v.includes(i)){p.setAttribute('d','');return;} const s=sn(i);
        p.setAttribute('d','M0 '+(-R)+'A'+Math.abs(R*s)+' '+R+' 0 0 '+(s>0?1:0)+' 0 '+R); });
      const hi=g.fill==='full'?1:g.fill==='lead'?sn(g.lead):-1, lo=g.drain?(v.length?Math.min(...v.map(sn)):1):-1;
      g.eq.setAttribute('x1',hi-lo<.01?0:lo*R); g.eq.setAttribute('x2',hi-lo<.01?0:hi*R);
      g.eq.style.opacity=hi-lo<.01?0:1;
    };
    g.frame=now=>{
      const dt=Math.min(.05,(now-g.last)/1000); g.last=now;
      const busy=g.on||vis().length>0;
      g.spin+=((busy?(g.on?3.2:4):0)-g.spin)*(1-Math.exp(-dt*4)); g.th+=g.spin*dt;
      g.mer.forEach((_,i)=>{ const f=front(i);
        if(f&&!g.was[i]){ g.alive[i]=g.on; if(g.alive[i]&&g.fill==='await'){g.fill='lead';g.lead=i;} }  // spun in over the left edge
        if(!f&&g.was[i]){ g.alive[i]=false; if(g.fill==='lead'&&i===g.lead) g.fill='full'; }          // left over the right edge
        g.was[i]=f; });
      if(g.drain&&!vis().length){ g.drain=false; g.fill='empty'; }
      g.render();
      g.raf=(g.on||g.fill!=='empty')&&orb.isConnected?requestAnimationFrame(g.frame):0;
    };
    g.set=on=>{
      if(on===g.on) return; g.on=on;
      if(reduce){ g.fill=on?'full':'empty'; g.drain=false; g.th=.4; g.mer.forEach((_,i)=>{g.alive[i]=on;g.was[i]=front(i);}); g.render(); return; }
      if(on){ g.drain=false; if(g.fill==='empty') g.fill='await'; }
      else if(g.fill==='await') g.fill='empty'; else if(g.fill!=='empty') g.drain=true;
      if(!g.raf){ g.last=performance.now(); g.raf=requestAnimationFrame(g.frame); }
    };
  }
  g.set(on);
}

// Orb + label for a bot message. Labels only show for pre-answer steps.
function setBotState(botMsgEl, state){
  if(!botMsgEl) return;
  setOrbState(botMsgEl.querySelector('.cloak-orb'), state);
  const label=botMsgEl.querySelector('.bot-label');
  if(!label) return;
  const t=BOT_STATE_LABELS[state]?(botMsgEl._preview||BOT_STATE_LABELS[state]):null;
  label.textContent=t||'Cloak';
  label.classList.toggle('cs-thinking-label',!!t);
}

/* ── STREAMING TAIL ORB ──
   While tokens stream, the orb leaves the header and rides just under the
   last line on the left, tweening down as each new line arrives. */
function _orbPos(body, el){
  const b=body.getBoundingClientRect(), r=el.getBoundingClientRect();
  return [r.left-b.left, r.top-b.top];
}
function tailOrb(botMsgEl){
  if(botMsgEl._tail) return botMsgEl._tail;
  const body=botMsgEl.querySelector('.bot-body'), meta=botMsgEl.querySelector('.bot-meta .cloak-orb');
  if(!body||!meta) return null;
  const t=document.createElement('span');
  t.className='orb-tail'; t.setAttribute('aria-hidden','true');
  t.innerHTML=CLOAK_ORB_HTML;
  const [x,y]=_orbPos(body,meta);
  t.style.transform='translate('+x+'px,'+y+'px)';
  body.appendChild(t);
  meta.style.visibility='hidden';
  botMsgEl.classList.add('orb-streaming');   // status row collapses: text starts where "Cloak is thinking…" was
  botMsgEl._tail=t;
  return t;
}
function placeTailOrb(botMsgEl, bc){
  const t=botMsgEl._tail; if(!t||!bc) return;
  bc.classList.add('has-tail');
  const body=botMsgEl.querySelector('.bot-body');
  const last=bc.lastElementChild||bc;
  const b=body.getBoundingClientRect(), c=bc.getBoundingClientRect(), l=last.getBoundingClientRect();
  const y=Math.round(l.bottom-b.top+8), x=Math.round(c.left-b.left);
  if(t._y===y) return;
  t._y=y;
  t.style.transform='translate('+x+'px,'+y+'px)';
}
// Tween back into the header, then hand off to the real orb.
function dockTailOrb(botMsgEl, done){
  const t=botMsgEl._tail;
  const meta=botMsgEl.querySelector('.bot-meta .cloak-orb');
  const bc=botMsgEl.querySelector('.bot-content');
  if(!t){ if(done) done(); return; }
  botMsgEl._tail=null;
  botMsgEl.classList.remove('orb-streaming');
  setOrbState(t.querySelector('.cloak-orb'),null);
  const body=botMsgEl.querySelector('.bot-body');
  if(meta&&body){ const [x,y]=_orbPos(body,meta); t.style.transform='translate('+x+'px,'+y+'px)'; }
  setTimeout(()=>{
    t.remove(); if(meta) meta.style.visibility='';
    if(bc) bc.classList.remove('has-tail');
    if(done) done();
  }, done===undefined?0:400);
}
function dropTailOrb(botMsgEl){ dockTailOrb(botMsgEl); }

// Finished messages: the orb rests below the answer (no trip back up).
function restOrbBelow(botMsgEl, state){
  const bc=botMsgEl&&botMsgEl.querySelector('.bot-content');
  if(!bc) return;
  const t=botMsgEl._tail; botMsgEl._tail=null;
  if(t) t.remove();
  bc.classList.remove('has-tail');
  botMsgEl.classList.remove('orb-streaming');
  const meta=botMsgEl.querySelector('.bot-meta .cloak-orb');
  if(meta) meta.style.visibility='hidden';
  botMsgEl.classList.add('orb-below');
  let end=botMsgEl.querySelector('.bot-end-orb');
  if(!end){
    end=document.createElement('div'); end.className='bot-end-orb';
    end.innerHTML=CLOAK_ORB_HTML;
    bc.insertAdjacentElement('afterend',end);
  }
  if(state) setOrbState(end.querySelector('.cloak-orb'),state);
  // One orb per chat — only the newest reply keeps it.
  document.querySelectorAll('.bot-end-orb').forEach(e=>{if(e!==end)e.remove();});
}

// Fly the resting orb from the previous reply into the new bubble's header.
function travelOrb(fromRect, botMsgEl){
  const meta=botMsgEl&&botMsgEl.querySelector('.bot-meta .cloak-orb');
  if(!meta||!fromRect) return;
  const to=meta.getBoundingClientRect();
  const fly=document.createElement('span');
  fly.className='orb-fly'; fly.setAttribute('aria-hidden','true');
  fly.innerHTML=CLOAK_ORB_HTML;
  fly.style.transform='translate('+fromRect.left+'px,'+fromRect.top+'px)';
  document.body.appendChild(fly);
  meta.style.opacity='0';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    fly.style.transform='translate('+to.left+'px,'+to.top+'px)';
  }));
  setTimeout(()=>{ fly.remove(); meta.style.opacity=''; }, 520);
}
function _takeRestingOrb(){
  const end=document.querySelector('#messages .bot-end-orb');
  if(!end) return null;
  const r=end.getBoundingClientRect();
  end.remove();
  return r.width?r:null;
}

/* ── STATUS LOG ──
   Thinking + research steps as single lines that pop in (styled like
   "Cloak is thinking…"). When the answer starts, the log collapses to a
   one-line summary you can click to reopen. */
function statusLog(botMsgEl){
  if(!botMsgEl) return null;
  if(botMsgEl._log) return botMsgEl._log;
  const body=botMsgEl.querySelector('.bot-body'),bc=botMsgEl.querySelector('.bot-content');
  if(!body||!bc) return null;
  const log=document.createElement('div');
  log.className='status-log';
  log.innerHTML='<button class="status-head" type="button" aria-expanded="false"><span class="status-head-label"></span><svg width="9" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button><div class="status-lines"></div>';
  const head=log.querySelector('.status-head');
  head.addEventListener('click',()=>{
    const o=log.classList.toggle('open');head.setAttribute('aria-expanded',o);
    log.querySelector('.status-head-label').textContent=o?'Hide thinking':'Show thinking';
  });
  log._t0=Date.now();
  body.insertBefore(log,bc);
  botMsgEl._log=log;
  return log;
}
function addStatus(botMsgEl,text,noPreview){
  const log=statusLog(botMsgEl);if(!log||log._done)return null;
  const lines=log.querySelector('.status-lines');
  const prev=lines.lastElementChild;if(prev)prev.classList.remove('live');
  const el=document.createElement('div');
  el.className='status-line live';el.textContent=text;
  lines.appendChild(el);
  if(!noPreview)setStatusPreview(botMsgEl,text,true);
  scrollBottom();
  return el;
}
// Collapsed view = one line: a preview of the latest status/thought.
// Each new line holds for at least 1s; if they arrive faster, the newest
// waiting one shows when the hold ends.
const STATUS_HOLD_MS=1000;
function setStatusPreview(botMsgEl,text,isNew){
  const log=botMsgEl&&botMsgEl._log;if(!log)return;
  // The preview lives in the label beside the orb (replacing "Cloak is thinking…").
  const show=(t,pop)=>{
    if(log._done)return;
    botMsgEl._preview=t;
    const lbl=botMsgEl.querySelector('.bot-label');
    if(!lbl||!lbl.classList.contains('cs-thinking-label'))return;
    lbl.textContent=t;
    if(pop){lbl.classList.remove('pop');void lbl.offsetWidth;lbl.classList.add('pop');log._shownAt=Date.now();}
  };
  if(!isNew){ if(log._pending==null) show(text,false); else log._pending=text; return; }
  const wait=(log._shownAt||0)+STATUS_HOLD_MS-Date.now();
  if(wait<=0&&log._pending==null){ show(text,true); return; }
  log._pending=text;
  if(!log._holdT) log._holdT=setTimeout(()=>{
    log._holdT=0;
    const t=log._pending; log._pending=null;
    if(t!=null) show(t,true);
  },Math.max(0,wait));
}
function finishStatus(botMsgEl){
  const log=botMsgEl&&botMsgEl._log;if(!log||log._done)return;
  log._done=true;
  clearTimeout(log._holdT);log._holdT=0;log._pending=null;
  botMsgEl._preview=null;
  log.querySelectorAll('.status-line.live').forEach(l=>l.classList.remove('live'));
  if(!log.querySelector('.status-line')){log.remove();botMsgEl._log=null;return;}
  log.querySelector('.status-head-label').textContent='Show thinking';
  log.classList.add('done');
}

function createCloakStatus(botMsgEl){
  if(!botMsgEl || !botMsgEl.querySelector('.bot-meta')) return null;
  setBotState(botMsgEl,'thinking');
  return {
    el: botMsgEl.querySelector('.cloak-orb'),
    setLabel(){ /* labels follow the state — no-op */ },
    dock(){ /* stays in place — no docking */ },
    exit(cb){ setBotState(botMsgEl,'streaming'); if(cb) cb(); },
    destroy(){ setBotState(botMsgEl,null); }
  };
}

/* ── PLUS MENU / MODES / IMAGE ── */
function togglePlusMenu(e){e.stopPropagation();document.getElementById('plus-menu').classList.toggle('open');}

function toggleHwMode(){
  hwMode=!hwMode;
  const hm=document.getElementById('menu-homework');if(hm)hm.classList.toggle('active-mode',hwMode);
  const hl=document.getElementById('hw-label');if(hl)hl.classList.toggle('show',hwMode);
  const pb=document.getElementById('plus-btn');if(pb)pb.classList.toggle('has-mode',hwMode||thinkModeActive||attachedImgs.length>0);
  const pm=document.getElementById('plus-menu');if(pm)pm.classList.remove('open');
}

function toggleThinkMode() {
  thinkModeActive=!thinkModeActive;
  const mt=document.getElementById('menu-think');if(mt)mt.classList.toggle('active-mode',thinkModeActive);
  const tl=document.getElementById('think-label');if(tl)tl.classList.toggle('show',thinkModeActive);
  const pb=document.getElementById('plus-btn');if(pb)pb.classList.toggle('has-mode',hwMode||thinkModeActive||attachedImgs.length>0);
  const pm=document.getElementById('plus-menu');if(pm)pm.classList.remove('open');
}

function onImgPick(inp){Array.from(inp.files).forEach(f=>{const r=new FileReader();r.onload=ev=>{attachedImgs.push({name:f.name,data:ev.target.result});renderImgStrip();};r.readAsDataURL(f);});inp.value='';}
function onPaste(e){const items=Array.from(e.clipboardData?.items||[]);const imageItems=items.filter(i=>i.type.startsWith('image/'));if(!imageItems.length)return;e.preventDefault();imageItems.forEach(item=>{const f=item.getAsFile();if(!f)return;const r=new FileReader();r.onload=ev=>{attachedImgs.push({name:'pasted.png',data:ev.target.result});renderImgStrip();};r.readAsDataURL(f);});}
function renderImgStrip(){
  const strip=document.getElementById('img-strip');strip.innerHTML='';
  if(attachedImgs.length){
    strip.classList.add('show');
    attachedImgs.forEach((img,i)=>{
      const w=document.createElement('div');w.className='img-thumb-wrap';
      w.innerHTML='<img class="img-thumb" src="'+img.data+'" alt="img"><button class="img-thumb-del" onclick="removeImg('+i+')">&times;</button>';
      strip.appendChild(w);
    });
  } else strip.classList.remove('show');
  const pb=document.getElementById('plus-btn');
  if(pb)pb.classList.toggle('has-mode',hwMode||thinkModeActive||attachedImgs.length>0);
}
function removeImg(i){attachedImgs.splice(i,1);renderImgStrip();}

document.addEventListener('click',()=>{document.getElementById('plus-menu')?.classList.remove('open');});

/* ── ONBOARDING ── */
let _onboardChecked=false;
function showOnboarding(){document.getElementById('onboard-modal').style.display='flex';}
function toggleOnboardCheck(){_onboardChecked=!_onboardChecked;document.getElementById('onboard-checkbox').classList.toggle('checked',_onboardChecked);const btn=document.getElementById('onboard-btn');btn.disabled=!_onboardChecked;btn.style.opacity=_onboardChecked?'1':'0.35';btn.style.cursor=_onboardChecked?'pointer':'not-allowed';}
async function confirmOnboarding(){document.getElementById('onboard-modal').style.display='none';onboardingDone=true;if(uid)await sb.from('profiles').update({onboarding_done:true}).eq('id',uid);}

/* ── AD CONSENT ── */
let _adDisagreeClicks=0;
function checkAdConsent(){const c=localStorage.getItem('cloak_ad_consent');if(c==='yes')loadAdSense();else if(!c)document.getElementById('ad-modal').style.display='flex';}
function loadAdSense(){if(document.getElementById('adsense-script'))return;const s=document.createElement('script');s.id='adsense-script';s.async=true;s.src='https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6774734854152622';s.crossOrigin='anonymous';document.head.appendChild(s);}
function handleAdAgree(){localStorage.setItem('cloak_ad_consent','yes');document.getElementById('ad-modal').style.display='none';loadAdSense();}
function handleAdDisagree(){_adDisagreeClicks++;const btn=document.getElementById('ad-disagree-btn');if(_adDisagreeClicks===1){btn.textContent='Are you sure?';btn.style.borderColor='var(--acc)';btn.style.color='var(--acc)';btn.style.fontWeight='800';}else{localStorage.setItem('cloak_ad_consent','no');document.getElementById('ad-modal').style.display='none';}}

/* ── LINK INTERCEPT ── */
let _pendingLink='';
function interceptLink(e,href){e.preventDefault();e.stopPropagation();if(!href||href==='#')return;_pendingLink=href;document.getElementById('link-url-display').textContent=href;document.getElementById('link-go-btn').onclick=()=>{window.open(_pendingLink,'_blank','noopener,noreferrer');closeLinkModal();};document.getElementById('link-modal').style.display='flex';}
function closeLinkModal(){document.getElementById('link-modal').style.display='none';_pendingLink='';}
document.addEventListener('DOMContentLoaded',()=>{const lm=document.getElementById('link-modal');if(lm)lm.addEventListener('click',function(e){if(e.target===this)closeLinkModal();});});

/* ── INIT ── */
async function init(){
  sb=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:window.localStorage}});
  await loadAppConfig();
  if(window.location.hash&&window.location.hash.includes('access_token'))window.history.replaceState(null,'',window.location.pathname);
  initThemeUI();
  let _routed=false;
  sb.auth.onAuthStateChange(async(ev,sess)=>{
    if(ev==='INITIAL_SESSION'){if(_routed)return;_routed=true;if(sess?.user){email=sess.user.email||'';uid=sess.user.id;guest=false;await enterChat();}else{hideLoading();show('auth');}}
    else if(ev==='SIGNED_IN'&&sess&&!_routed){_routed=true;email=sess.user.email||'';uid=sess.user.id;guest=false;await enterChat();}
    else if(ev==='SIGNED_OUT'){_routed=false;entering=false;convs=[];chatId=null;hist=[];admin=false;name='';guest=false;if(window.CloakMemory)CloakMemory.reset();if(window.CloakContext)CloakContext.reset();show('auth');}
    else if(ev==='TOKEN_REFRESHED'&&sess){email=sess.user.email||'';uid=sess.user.id;}
  });
  setTimeout(async()=>{if(_routed)return;try{const{data:{session}}=await sb.auth.getSession();if(_routed)return;_routed=true;if(session?.user){email=session.user.email||'';uid=session.user.id;guest=false;await enterChat();}else{hideLoading();show('auth');}}catch(e){_routed=true;hideLoading();show('auth');}},800);
}

function hideLoading(){var el=document.getElementById('s-loading');if(!el)return;el.classList.add('hidden');setTimeout(()=>{el.style.display='none';},220);}

async function enterChat(){
  if(entering)return;entering=true;
  try{
    await whenDomReady();
    hideLoading();
    document.querySelectorAll('.screen').forEach(el=>{el.classList.remove('active');el.style.display='';});
    const valuesEl=document.getElementById('s-values');if(valuesEl)valuesEl.style.display='none';
    const chatEl=document.getElementById('s-chat');if(!chatEl)return;
    chatEl.classList.add('active');
    if(window._vv)window._vv();
    if(!guest)name=name||email.split('@')[0];
    refreshUI();updateGreeting();
    if(window.CloakMemory)CloakMemory.init({sb,uid:guest?'':uid,guest}).catch(e=>log('err','Memory: '+e.message));
    if(!guest)Promise.all([loadProfile(),loadConvs(),loadAnn()]).catch(()=>{});
    else{try{document.getElementById('guest-note').style.display='block';}catch(e){}log('inf','Guest mode');}
  }finally{entering=false;}
}

function startGuest(){guest=true;guestN=0;name='';email='';uid='';entering=false;hideLoading();enterChat();}
/* ── WELCOME GREETING ──
   One line, picked from context (most specific wins): holidays → just
   finished a chat → first visit → back after a while → late night →
   day of week → time of day. Time of day also sets data-mood, which drives
   how the welcome orb idles (cloak.css). */
const _GREET_SEEN_KEY='cloak_last_seen';
let _greetPrevSeen=0;
try{_greetPrevSeen=+localStorage.getItem(_GREET_SEEN_KEY)||0;localStorage.setItem(_GREET_SEEN_KEY,String(Date.now()));}catch(_){}
let _greetAfterChat=false;   // set by newChat() when leaving a conversation

function _greetMood(d){
  const h=d.getHours();
  return h>=5&&h<12?'morning':h>=12&&h<17?'afternoon':h>=17&&h<22?'evening':'night';
}
function _greetText(d,mood,who){
  const n=who?', '+who:'';
  const md=(d.getMonth()+1)+'-'+d.getDate(), day=d.getDay(), h=d.getHours();
  const holiday={'1-1':'Happy New Year'+n+'!','2-14':'Happy Valentine’s'+n+'!','10-31':'Happy Halloween'+n+'!','12-24':'Merry Christmas Eve'+n+'!','12-25':'Merry Christmas'+n+'!','12-31':'Last one of the year'+n+'!'}[md];
  if(holiday)return holiday;
  if(_greetAfterChat)return who?'What’s next'+n+'?':'What’s next?';
  if(who&&!_greetPrevSeen)return 'Welcome'+n+'!';
  const away=_greetPrevSeen?Date.now()-_greetPrevSeen:0;
  if(who&&away>7*864e5)return 'Welcome back'+n+'!';
  if(mood==='night')return 'Up late'+n+'?';
  if(day===1&&mood==='morning')return 'Happy Monday'+n+'!';
  if(day===5&&h>=12)return 'Happy Friday'+n+'!';
  if(day===0||day===6)return 'Happy '+(day===6?'Saturday':'Sunday')+n+'!';
  const hi={morning:'Morning',afternoon:'Afternoon',evening:'Evening'}[mood];
  return who?hi+n+'!':'Good '+hi.toLowerCase()+'!';
}
function updateGreeting(){
  const d=new Date(),mood=_greetMood(d);
  const who=(name||'').trim().split(/\s+/)[0];
  const el=document.getElementById('empty-greeting');
  if(el)el.textContent=_greetText(d,mood,who);
  const w=document.getElementById('welcome');
  if(w)w.dataset.mood=mood;
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateGreeting();});

/* ── AUTH ── */
let signingIn=true;
function authMode(m){signingIn=m==='in';document.getElementById('tab-in').classList.toggle('active',signingIn);document.getElementById('tab-up').classList.toggle('active',!signingIn);document.getElementById('field-name').style.display=signingIn?'none':'block';document.getElementById('field-confirm').style.display=signingIn?'none':'block';document.getElementById('btn-submit').textContent=signingIn?'Sign in':'Create account';clearE('auth-err');}
function authKey(e,nextId,isPass=false){if(e.key==='Enter'){e.preventDefault();if(isPass&&signingIn){handleAuth();return;}if(nextId){const next=document.getElementById(nextId);if(next&&next.offsetParent!==null){next.focus();return;}}handleAuth();}}
async function handleAuth(){
  const em=document.getElementById('inp-email').value.trim();const pw=document.getElementById('inp-pass').value;
  const err=document.getElementById('auth-err');const btn=document.getElementById('btn-submit');
  if(!em||!pw){showE(err,'Please fill in all fields.');return;}
  btn.disabled=true;
  if(signingIn){
    btn.textContent='Signing in\u2026';
    const{data:d,error:e}=await sb.auth.signInWithPassword({email:em,password:pw});
    if(e){showE(err,e.message);}else if(d?.session){email=d.session.user.email||'';uid=d.session.user.id;guest=false;await enterChat();return;}
  }else{
    const nm=document.getElementById('inp-name').value.trim();const cf=document.getElementById('inp-confirm').value;
    btn.textContent='Creating\u2026';
    if(pw!==cf){showE(err,'Passwords do not match.');btn.disabled=false;btn.textContent='Create account';return;}
    if(pw.length<8){showE(err,'Password must be at least 8 characters.');btn.disabled=false;btn.textContent='Create account';return;}
    const{error:e}=await sb.auth.signUp({email:em,password:pw,options:{data:{display_name:nm||em.split('@')[0]}}});
    if(e){showE(err,e.message);}else{verifyEmail=em;document.getElementById('verify-addr').textContent=em;show('verify');return;}
  }
  btn.disabled=false;btn.textContent=signingIn?'Sign in':'Create account';
}
async function resendVerify(){if(!verifyEmail)return;await sb.auth.resend({type:'signup',email:verifyEmail});}
async function handleMfa(){
  const code=document.getElementById('mfa-code').value.trim();const err=document.getElementById('mfa-err');
  if(code.length<6){showE(err,'Enter the 6-digit code.');return;}
  try{const{data:f}=await sb.auth.mfa.listFactors();const t=f?.totp?.[0];if(!t){showE(err,'No authenticator registered.');return;}const{data:ch}=await sb.auth.mfa.challenge({factorId:t.id});const{error:e}=await sb.auth.mfa.verify({factorId:t.id,challengeId:ch.id,code});if(e){showE(err,e.message);return;}enterChat();}catch(ex){showE(err,ex.message);}
}
async function doLogout(){hapticTap();await sb.auth.signOut();show('auth');}

/* ── PROFILE ── */
async function loadProfile(){
  try{
    const{data}=await sb.from('profiles').select('*').eq('id',uid).single();
    if(data){name=data.display_name||email.split('@')[0];admin=data.is_admin||email===ADMIN;onboardingDone=data.onboarding_done||false;}
    else{name=email.split('@')[0];admin=email===ADMIN;onboardingDone=false;await sb.from('profiles').upsert({id:uid,display_name:name,is_admin:admin,onboarding_done:false},{onConflict:'id'});}
    if(admin){document.getElementById('snav-admin').style.display='flex';loadAdminAnns();}
    refreshUI();updateGreeting();if(!onboardingDone)showOnboarding();
  }catch(e){log('err','Profile load: '+e.message);}
}
async function saveName(){
  const n=document.getElementById('s-name-inp').value.trim();if(!n)return;
  name=n;if(!guest){const{error}=await sb.from('profiles').upsert({id:uid,display_name:n},{onConflict:'id'});if(error)log('err','Name save: '+error.message);else log('inf','Name saved: '+n);}
  refreshUI();updateGreeting();const b=document.querySelector('#spane-general .cta');if(b){b.textContent='Saved';setTimeout(()=>b.textContent='Save',1800);}
}

/* ── ANNOUNCEMENTS ── */
async function loadAnn(){
  try{const{data}=await sb.from('announcements').select('*').eq('active',true).order('created_at',{ascending:false}).limit(1);if(!data?.length)return;const a=data[0];if(localStorage.getItem('cloak_ann')===a.id)return;annId=a.id;document.getElementById('ann-msg').textContent=a.message;document.getElementById('ann-bar').classList.add('show');const sbAnn=document.getElementById('sb-ann-bar');const sbAnnMsg=document.getElementById('sb-ann-msg');if(sbAnn&&sbAnnMsg){sbAnnMsg.textContent=a.message;sbAnn.style.display='block';}}catch(e){}
}
function dismissAnn(){if(annId)localStorage.setItem('cloak_ann',annId);document.getElementById('ann-bar').classList.remove('show');const sbAnn=document.getElementById('sb-ann-bar');if(sbAnn)sbAnn.style.display='none';}
async function postAnn(){const m=document.getElementById('ann-compose').value.trim();if(!m)return;const{error}=await sb.from('announcements').insert({message:m,created_by:uid});if(!error){document.getElementById('ann-compose').value='';loadAnn();loadAdminAnns();log('inf','Announcement posted');}else log('err','Post failed: '+error.message);}
async function loadAdminAnns(){const{data}=await sb.from('announcements').select('*').order('created_at',{ascending:false});const el=document.getElementById('admin-ann-list');if(!el)return;if(!data?.length){el.innerHTML='<div style="font-size:13px;opacity:.55">None active.</div>';return;}el.innerHTML=data.map(a=>'<div class="ann-row"><div class="ann-row-msg">'+hesc(a.message)+(a.active?'':' <span style="opacity:.4;font-size:10px">(inactive)</span>')+'<\/div><button class="ann-deact" onclick="deactAnn(\''+a.id+'\')">Delete<\/button><\/div>').join('');}
async function deactAnn(id){await sb.from('announcements').delete().eq('id',id);if(annId===id){annId=null;document.getElementById('ann-bar').classList.remove('show');const sbAnn=document.getElementById('sb-ann-bar');if(sbAnn)sbAnn.style.display='none';localStorage.removeItem('cloak_ann');}loadAdminAnns();}

/* ── GUEST LIMIT ── */
function showLimit(){if(document.getElementById('limit-modal'))return;const d=document.createElement('div');d.id='limit-modal';d.className='limit-overlay';d.innerHTML='<div class="limit-card"><div class="limit-title">You\'re loving Cloak!</div><div class="limit-body">You\'ve used your '+GUEST_MAX+' guest messages.<br>Create a free account to keep going.</div><button class="btn-primary" onclick="goSignUp()">Create free account</button><br><button class="limit-skip" onclick="dismissLimit()">Maybe later</button></div>';document.body.appendChild(d);}
function goSignUp(){const d=document.getElementById('limit-modal');if(d)d.remove();show('auth');authMode('up');}
function dismissLimit(){const d=document.getElementById('limit-modal');if(d)d.remove();}

/* ── UI HELPERS ── */
function show(id){hideLoading();document.querySelectorAll('.screen').forEach(el=>{el.classList.remove('active');el.style.display='';});const chatEl=document.getElementById('s-chat');if(chatEl)chatEl.classList.remove('active');const valuesEl=document.getElementById('s-values');if(valuesEl)valuesEl.style.display='none';var el=document.getElementById('s-'+id);if(!el)return;el.classList.add('active');if(id!=='chat')el.style.display='flex';}
function refreshUI(){
  const i=name?name[0].toUpperCase():email?email[0].toUpperCase():'G';
  ['sb-av','s-av'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=i;});
  document.getElementById('sb-name').textContent=guest?'Guest':(name||email.split('@')[0]);
  document.getElementById('sb-email').textContent=guest?'Not signed in':email;
  document.getElementById('s-name').textContent=guest?'Guest':(name||'—');
  document.getElementById('s-email').textContent=guest?'Not signed in':email;
  document.querySelectorAll('.moon').forEach(el=>el.style.display=dark?'none':'block');
  document.querySelectorAll('.sun').forEach(el=>el.style.display=dark?'block':'none');
}
function toggleDark(){hapticTap();dark=!dark;document.body.classList.toggle('dark',dark);document.documentElement.classList.toggle('dark',dark);localStorage.setItem('cloak_dark',dark?'1':'0');const ml=document.getElementById('mode-label');if(ml)ml.textContent=dark?'dark':'light';refreshUI();syncThemeColor();}
function toggleSidebar(){hapticTap();const el=document.getElementById('sidebar');const mobile=window.innerWidth<=640;if(mobile){const open=!el.classList.contains('collapsed');if(open){el.classList.add('collapsed');document.getElementById('sb-overlay').classList.remove('show');}else{el.classList.remove('collapsed');document.getElementById('sb-overlay').classList.add('show');}}else el.classList.toggle('collapsed');}
function closeMobileSidebar(){document.getElementById('sidebar').classList.add('collapsed');document.getElementById('sb-overlay').classList.remove('show');}

/* ── SETTINGS (full-page screen) ── */
let _prevScreen='chat';
function openSettings(){
  if(guest){show('auth');return;}
  hapticTap();
  // Remember where we came from so the back button returns there.
  const active=document.querySelector('.screen.active');
  _prevScreen = (active && active.id && active.id!=='s-settings') ? active.id.replace(/^s-/,'') : 'chat';
  try{ closeMobileSidebar(); }catch(_){ }
  document.getElementById('s-name-inp').value=name;
  document.getElementById('mode-label').textContent=dark?'dark':'light';
  show('settings');
  initThemeUI();if(admin)loadAdminAnns();updateStats();renderLogs();
}
function closeSettings(){ hapticTap(); show(_prevScreen||'chat'); }
function closeModal(id){const el=document.getElementById(id);if(!el)return;el.classList.add('hiding');setTimeout(()=>{el.style.display='none';el.classList.remove('hiding');},120);}
function overlayClick(e,id){if(e.target===document.getElementById(id))closeModal(id);}
function switchSettingsTab(t){hapticTap();atab=t;document.querySelectorAll('.snav-btn').forEach(el=>el.classList.toggle('on',el.id==='snav-'+t));document.querySelectorAll('.spane').forEach(el=>el.classList.remove('on'));const p=document.getElementById('spane-'+t);if(p)p.classList.add('on');if(t==='console'){updateStats();renderLogs();}}
async function clearAllChats(){if(!confirm('Delete ALL conversations?'))return;const{error}=await sb.from('chats').delete().eq('user_id',uid);if(error)log('err','Clear failed: '+error.message);else{convs=[];newChat();log('inf','All chats deleted');}}

/* ── 2FA ── */
async function start2FA(){try{const{data,error}=await sb.auth.mfa.enroll({factorType:'totp'});if(error)throw error;const sec=document.getElementById('totp-section');sec.style.display='block';document.getElementById('totp-secret').textContent='Secret: '+data.totp.secret;document.getElementById('totp-qr').innerHTML='<img src="'+data.totp.qr_code+'" style="width:160px;height:160px;border:var(--bd)" />';window._totpFactorId=data.id;}catch(e){alert('2FA setup failed: '+e.message);}}
async function confirmTOTP(){const code=document.getElementById('totp-code').value.trim();const err=document.getElementById('totp-err');if(!code){showE(err,'Enter code');return;}try{const{data:ch}=await sb.auth.mfa.challenge({factorId:window._totpFactorId});const{error}=await sb.auth.mfa.verify({factorId:window._totpFactorId,challengeId:ch.id,code});if(error){showE(err,error.message);return;}document.getElementById('totp-section').style.display='none';alert('2FA enabled!');}catch(e){showE(err,e.message);}}

/* ── CONSOLE ── */
function log(type,msg){const n=new Date();const ts=n.toLocaleTimeString('en-US',{hour12:false})+'.'+String(n.getMilliseconds()).padStart(3,'0');logs.push({type,msg,ts});if(logs.length>500)logs.shift();if(document.getElementById('s-settings')?.classList.contains('active')&&atab==='console'){renderLogs();updateStats();}}
function renderLogs(){const box=document.getElementById('console-log');const fl=logF==='all'?logs:logs.filter(l=>l.type===logF);if(!fl.length){box.innerHTML='<div class="log-empty">No logs yet</div>';return;}box.innerHTML=fl.map(l=>'<div class="log-row"><span class="log-ts">'+l.ts+'</span><span class="log-badge b-'+l.type+'">'+l.type+'</span><div class="log-msg">'+hesc(l.msg)+'</div></div>').join('');box.scrollTop=box.scrollHeight;}
function updateStats(){document.getElementById('st-req').textContent=stats.req;document.getElementById('st-res').textContent=stats.res;document.getElementById('st-err').textContent=stats.err;const avg=stats.lat.length?Math.round(stats.lat.reduce((a,b)=>a+b,0)/stats.lat.length):null;document.getElementById('st-lat').textContent=avg?avg+'ms':'—';}
function setFilter(f,el){logF=f;document.querySelectorAll('.filter-pill').forEach(b=>b.classList.remove('on'));el.classList.add('on');renderLogs();}
function clearLogs(){logs=[];stats={req:0,res:0,err:0,lat:[]};renderLogs();updateStats();}

/* ── STORAGE ── */
async function loadConvs(){const{data,error}=await sb.from('chats').select('id,title,updated_at').eq('user_id',uid).order('updated_at',{ascending:false});if(error){log('err','Load convs: '+error.message);return;}convs=(data||[]).map(r=>({id:r.id,title:r.title}));renderConvs();log('inf','Loaded '+convs.length+' chat(s)');}
async function loadConv(id){const{data,error}=await sb.from('chats').select('*').eq('id',id).single();if(error){log('err','Load chat: '+error.message);return;}if(window.CloakMemory)CloakMemory.flush();chatId=id;hist=data.messages||[];if(window.CloakContext)CloakContext.load(data.context);document.getElementById('messages').innerHTML='';hist.forEach(m=>addMsg(m.role==='CHATBOT'?'bot':'user',m.message,true));trimToLatest();showMessages();renderConvs();}
function _makeTitle(first){const clean=first.replace(/\n+/g,' ').replace(/\s+/g,' ').trim();const sentenceEnd=clean.search(/[.!?](?:\s|$)/);let candidate=sentenceEnd>4&&sentenceEnd<70?clean.slice(0,sentenceEnd+1):clean;if(candidate.length>60)candidate=candidate.slice(0,58).replace(/\s+\S*$/,'')+'\u2026';return candidate||'New chat';}
async function saveConv(first){if(!uid||guest)return;let currentUid=uid;try{const{data:{session}}=await sb.auth.getSession();if(!session?.user){log('err','Save aborted: no session');return;}currentUid=session.user.id;uid=currentUid;}catch(e){log('err','Save: session check failed');return;}const ex=convs.find(c=>c.id===chatId);const title=ex?ex.title:_makeTitle(first);if(!ex)convs.unshift({id:chatId,title});renderConvs();const row={id:chatId,user_id:currentUid,title,messages:hist,updated_at:new Date().toISOString()};if(window.CloakContext)row.context=CloakContext.get();let{error}=await sb.from('chats').upsert(row,{onConflict:'user_id,id'});if(error&&row.context&&/context/i.test(error.message)){delete row.context;({error}=await sb.from('chats').upsert(row,{onConflict:'user_id,id'}));}if(error){log('err','Save: '+error.message);}else{log('inf','Chat saved: '+title.slice(0,30));}}
async function delConv(id){const{error}=await sb.from('chats').delete().eq('id',id).eq('user_id',uid);if(error){log('err','Delete: '+error.message);return;}convs=convs.filter(c=>c.id!==id);if(chatId===id)newChat();else renderConvs();}

/* ── MENTAL HEALTH INTERCEPT ── */
const MH_PATTERNS=/\b(suicide|suicidal|kill myself|end my life|want to die|self[- ]?harm|cut myself|overdose|no reason to live|don't want to be here|can't go on|hopeless|worthless|crisis)\b/i;
let _mhShown=false;
function checkMentalHealth(txt){
  if(_mhShown||!MH_PATTERNS.test(txt))return false;
  _mhShown=true;
  const box=document.getElementById('messages');showMessages();
  const d=document.createElement('div');d.className='mh-intercept';
  d.innerHTML='<div class="mh-icon"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></div><div class="mh-body"><strong>A note before you continue</strong><p>Cloak is not a mental health resource. If you\'re going through something hard, please reach out to a real person or a helpline — <a href="https://findahelpline.com" target="_blank" rel="noopener noreferrer">findahelpline.com</a> lists free crisis support in your country.</p></div><button class="mh-dismiss" onclick="this.parentElement.style.display=\'none\'">Got it</button>';
  box.appendChild(d);scrollBottom();return false;
}

/* ════════════════════════════════════════════
   SEND — the main entry point
   ════════════════════════════════════════════ */
async function send(){
  const inp=document.getElementById('chat-input');
  const txt=inp.value.trim();
  if((!txt&&!attachedImgs.length)||busy)return;
  if(guest&&guestN>=GUEST_MAX){showLimit();return;}
  checkMentalHealth(txt);
  if(!chatId){chatId=Date.now().toString();hist=[];}

  if(voiceMode){voiceState='thinking';if(recognition)recognition.stop();}

  const imgs=[...attachedImgs];
  attachedImgs=[];renderImgStrip();

  inp.value='';inp.style.height='auto';
  setBusy(true);
  addMsg('user',txt,false,imgs);

  const t0=Date.now();
  const hasImages=imgs.length>0;
  const model=window.cloakModel||'pneuma';
  const useThoughts=_shouldThink(model);

  let userMsg=txt;
  if(hwMode&&txt)userMsg='[HOMEWORK MODE]\n\n'+txt;
  if(!userMsg&&hasImages)userMsg='[Image]';
  hist.push({role:'USER',message:userMsg});

  stats.req++;
  log('req',`"${(txt||'[image]').slice(0,60)}" model=${model} guest=${guest} hwMode=${hwMode} thinkMode=${thinkModeActive} imgs=${imgs.length} thoughts=${useThoughts}`);

  // Create bot bubble + Cloak status hero animation
  showMessages();
  const botMsgEl = insertBotBubbleForThoughts();
  try { botMsgEl._status = createCloakStatus(botMsgEl); } catch(_) { botMsgEl._status = null; }
  // Safety net: if the status failed to build, show the classic typing dots so
  // the wait is never a blank screen.
  if(!botMsgEl._status){
    const bc=botMsgEl.querySelector('.bot-content');
    if(bc) bc.innerHTML='<div class="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
  }

  // Build API request body
  const apiMessages = hist.slice(0,-1).map(m=>({
    role: m.role==='CHATBOT'?'assistant':'user',
    content: m.message,
  }));
  apiMessages.push({role:'user', content:userMsg||'[Image]'});

  let imageBase64=null, mimeType=null;
  if(hasImages && imgs[0]){
    const match=imgs[0].data.match(/^data:([^;]+);base64,(.+)$/);
    if(match){mimeType=match[1];imageBase64=match[2];}
  }

  const trimmedMessages=apiMessages.slice(-20);
  const bodyObj={model,messages:trimmedMessages,imageBase64:imageBase64||undefined,mimeType:mimeType||undefined};

  log('inf',`→ ${CLOAK_API}/v1/chat model=${model} turns=${trimmedMessages.length} thoughts=${useThoughts}`);

  // Kick off main fetch — store result in a resolvable promise
  _fetchController=new AbortController();
  let _responseResolve, _responseReject;
  const responsePromise=new Promise((res,rej)=>{_responseResolve=res;_responseReject=rej;});

  const fetchAndResolve = async () => {
    try {
      const res=await fetch(CLOAK_API+'/v1/chat',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        signal:_fetchController.signal,
        body:JSON.stringify(bodyObj),
      });
      _fetchController=null;
      let d;
      try{d=await res.json();}catch(_){throw new Error('Server returned an unreadable response.');}
      if(!res.ok||d.error)throw new Error(d.error||'HTTP '+res.status);
      const responseText=d.response||d.text||'';
      if(!responseText)throw new Error('Empty response from server.');
      _responseResolve({responseText, ms: Date.now()-t0, model: d.model||model});
    } catch(ex) {
      _responseReject(ex);
    }
  };

  fetchAndResolve();

  try {
    // The Cloak status glyph (created above) morphs on its own while we wait.

    // Wait for the actual response
    const {responseText, ms, model: respModel} = await responsePromise;

    stats.lat.push(ms);
    stats.res++;
    log('res',`${ms}ms | model=${respModel} | len=${responseText.length}`);

    hist.push({role:'CHATBOT',message:responseText});

    replaceThinkWithContent(botMsgEl, responseText);

    if(voiceMode)playVoice(responseText);
    if(guest){guestN++;if(guestN>=GUEST_MAX)setTimeout(showLimit,500);}
    else saveConv(txt||'[Image]').catch(e=>log('err','Save: '+e.message));

  } catch(ex) {
    _fetchController=null;
    stopThinkAnimation();
    if(ex.name==='AbortError'){
      botMsgEl.remove();
      if(hist.length&&hist[hist.length-1].role==='USER')hist.pop();
      setBusy(false);
    } else {
      stats.err++;
      log('err',ex.message);
      const errTxt=ex.message.match(/^(HTTP 5|Service|No response|Empty)/i)
        ?'Service temporarily unavailable — please try again in a moment.'
        :hesc(ex.message);
      replaceThinkWithContent(botMsgEl,'Error: '+errTxt);
      if(voiceMode)playVoice('Sorry, I ran into an error.');
    }
  }
}

(function(){const sb=document.getElementById('sidebar');if(window.innerWidth<=640&&sb)sb.classList.add('collapsed');})();

/* ── SIDEBAR FOOTER ALIGNMENT ──
   Footer min-height = input-area height, so the line above "Account" sits on
   the same y as the line above the message box. Only re-measured while the
   box is empty so a growing multi-line draft doesn't drag the sidebar line. */
(function(){
  const ia=document.querySelector('.input-area'),sb=document.getElementById('sidebar'),inp=document.getElementById('chat-input');
  if(!ia||!sb)return;
  const sync=()=>{if(inp&&inp.value)return;const h=ia.getBoundingClientRect().height;if(h)sb.style.setProperty('--input-h',h+'px');};
  if('ResizeObserver' in window)new ResizeObserver(sync).observe(ia);
  window.addEventListener('resize',sync);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(sync);
  sync();
})();
whenDomReady().then(()=>{checkAdConsent();syncThemeColor();init();});

/* ── PWA: register the app-shell service worker (non-blocking) ── */
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js?v=20260926mem2').catch(e=>console.warn('SW registration failed',e));
  });
}
