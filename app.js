'use strict';

const ENDPOINT = (window.STUDY_CONFIG || {}).endpoint || '';
const PREVIEW = !ENDPOINT;
const STORE_KEY = 'edit_study_v1';
const SUBMIT_TRIES = 5;
const QUESTIONS = [
  ['quality', 'Image quality', 'Looking at A and B on their own, which looks more natural, throughout the edits and especially at the last edit?',
    'Look for patchy areas, unnatural-looking parts, artifacts and blur.'],
  ['editing', 'Instruction following', 'Which result better carries out the edit instructions?',
    'Did each edit take effect, on the right object? An edit can be done in more than one way; any reasonable way counts.'],
  ['preservation', 'Preservation', 'Compared with the original, which result better keeps the parts that no instruction asked to change (people, background, other objects)?'],
];
const CHOICES = [['A', 'A is better'], ['B', 'B is better'], ['tie', 'About the same']];

const $ = (id) => document.getElementById(id);
let study = null;
let state = null;
let screenStart = 0;

// ---------- storage (best effort: the study works without it) ----------
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function randomId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- server ----------
async function assignSlot(session) {
  if (PREVIEW) {
    const s = parseInt(new URLSearchParams(location.search).get('s') || '1', 10);
    return Math.min(Math.max(s, 1), study.slots.length) - 1;
  }
  const r = await fetch(`${ENDPOINT}?action=assign&session=${encodeURIComponent(session)}`);
  const j = await r.json();
  if (typeof j.slot !== 'number') throw new Error(j.error || 'no slot');
  return j.slot;
}

async function post(payload) {
  if (PREVIEW) return true;
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload) });
    const j = await r.json();
    return !!j.ok;
  } catch (e) {
    return false;
  }
}

// All answers go to the server in one request, after the last screen. The server ignores
// a second submit of the same session, so a retry after a lost response is safe.
async function submit() {
  const answers = state.seq.map((_, i) => state.answers[i]);
  return post({ action: 'submit', session: state.session, slot: state.slot, answers });
}

// ---------- session ----------
function buildSequence(slot) {
  return shuffle(study.slots[slot].map((p) => ({ ...p, kind: 'pair' })));
}

async function start() {
  $('start').disabled = true;
  $('start-error').hidden = true;
  try {
    if (!state || state.version !== study.version) {
      const session = randomId();
      const slot = await assignSlot(session);
      state = {
        version: study.version, session, slot, seq: buildSequence(slot),
        pos: 0, answers: {}, done: false, submitted: false,
        startedAt: new Date().toISOString(),
      };
      saveState();
    }
    if (state.done) return showDone();
    showTask();
  } catch (e) {
    $('start-error').textContent = 'Could not start the study (network problem?). Please reload and try again.';
    $('start-error').hidden = false;
    $('start').disabled = false;
  }
}

// ---------- rendering ----------
function imgPath(chain, code, turn) {
  return `img/${chain.id}/${code}_${String(turn).padStart(2, '0')}.jpg`;
}

function preload(item) {
  if (!item) return;
  const chain = study.chains[item.chain];
  for (let t = 1; t <= study.n_turns; t++) {
    new Image().src = imgPath(chain, item.A, t);
    new Image().src = imgPath(chain, item.B, t);
  }
}

function showTask() {
  $('intro').hidden = true;
  $('done').hidden = true;
  $('task').hidden = false;
  renderItem();
}

function renderItem() {
  const item = state.seq[state.pos];
  const chain = study.chains[item.chain];
  const n = state.seq.length;
  $('progress-text').textContent = `Comparison ${state.pos + 1} of ${n}`;
  $('progress-bar').style.width = `${(100 * state.pos) / n}%`;

  // src.jpg keeps its name across rebuilds, so tag it with the version to skip stale caches.
  $('img-src').src = `img/${chain.id}/src.jpg?v=${study.version}`;

  const ticks = $('ticks');
  ticks.innerHTML = '';
  for (let t = 1; t <= study.n_turns; t++) {
    const s = document.createElement('span');
    s.textContent = t;
    ticks.appendChild(s);
  }

  item.current = item.current || { seen: [], choice: {}, ms: 0 };
  const slider = $('slider');
  slider.max = study.n_turns;
  slider.value = item.current.turn || 1;
  setTurn(+slider.value);

  const qbox = $('questions');
  qbox.innerHTML = '';
  QUESTIONS.forEach(([key, title, text, lookFor]) => {
    const q = document.createElement('div');
    q.className = 'question';
    q.dataset.key = key;
    const qtext = document.createElement('div');
    qtext.className = 'qtext';
    const h = document.createElement('h3');
    h.textContent = title;
    qtext.appendChild(h);
    const p = document.createElement('p');
    p.textContent = text;
    qtext.appendChild(p);
    if (lookFor) {
      const lf = document.createElement('p');
      lf.className = 'look-for';
      lf.textContent = lookFor;
      qtext.appendChild(lf);
    }
    q.appendChild(qtext);
    const row = document.createElement('div');
    row.className = 'choices';
    row.dir = 'ltr';
    CHOICES.forEach(([val, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `opt-${val}`;
      b.dataset.val = val;
      b.textContent = label;
      b.addEventListener('click', () => choose(key, val));
      row.appendChild(b);
    });
    q.appendChild(row);
    qbox.appendChild(q);
  });
  refreshChoices();
  preload(item);
  preload(state.seq[state.pos + 1]);
  screenStart = Date.now();
  window.scrollTo(0, 0);
}

function setTurn(t) {
  const item = state.seq[state.pos];
  const chain = study.chains[item.chain];
  item.current.turn = t;
  if (!item.current.seen.includes(t)) item.current.seen.push(t);
  $('img-a').src = imgPath(chain, item.A, t);
  $('img-b').src = imgPath(chain, item.B, t);
  $('turn-label').textContent = `Current edit instruction (edit ${t} of ${study.n_turns})`;
  $('instruction').textContent = chain.instructions[t - 1];
  [...$('ticks').children].forEach((s, i) => s.classList.toggle('seen', item.current.seen.includes(i + 1)));
  $('step').disabled = t >= study.n_turns;
  $('step-back').disabled = t <= 1;
  refreshChoices();
}

function unlocked() {
  return state.seq[state.pos].current.seen.includes(study.n_turns);
}

function choose(key, val) {
  if (!unlocked()) return;
  state.seq[state.pos].current.choice[key] = val;
  saveState();
  refreshChoices();
}

function refreshChoices() {
  const item = state.seq[state.pos];
  const open = unlocked();
  $('slider-hint').hidden = open;
  document.querySelectorAll('.question').forEach((q) => {
    q.classList.toggle('locked', !open);
    const val = item.current.choice[q.dataset.key];
    q.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b.dataset.val === val));
  });
  $('next').disabled = !(open && QUESTIONS.every(([k]) => item.current.choice[k]));
  $('next').textContent = state.pos === state.seq.length - 1 ? 'Submit' : 'Next';
  $('prev').disabled = state.pos === 0;
}

function layoutCheck() {
  // Record where A and B actually landed on screen, so a mirrored layout would be caught.
  const a = $('panel-a').getBoundingClientRect();
  const b = $('panel-b').getBoundingClientRect();
  const qa = document.querySelector('.choices .opt-A').getBoundingClientRect();
  const qb = document.querySelector('.choices .opt-B').getBoundingClientRect();
  const src = $('panel-src').getBoundingClientRect();
  return { a_left_of_b: src.left < a.left && a.left < b.left, a_button_left_of_b: qa.left < qb.left };
}

async function next() {
  if (state.done) return;  // a double click on Submit
  const item = state.seq[state.pos];
  const chain = study.chains[item.chain];
  const record = {
    session: state.session,
    slot: state.slot,
    index: state.pos,
    kind: item.kind,
    chain: chain.id,
    A: item.A,
    B: item.B,
    ...item.current.choice,
    turns_seen: item.current.seen.length,
    ms: (item.current.ms += Date.now() - screenStart),
    lang: navigator.language,
    dir: getComputedStyle($('pair')).direction,
    width: window.innerWidth,
    ...layoutCheck(),
  };
  state.answers[state.pos] = record;
  if (state.pos < state.seq.length - 1) {
    state.pos += 1;
    saveState();
    renderItem();
  } else {
    state.done = true;
    saveState();
    showDone();
  }
}

async function showDone() {
  $('intro').hidden = true;
  $('task').hidden = true;
  $('done').hidden = false;
  if (PREVIEW) {
    $('done-text').textContent = `Preview mode (slot ${state.slot + 1}): answers were not sent anywhere.`;
    $('download').hidden = false;
    return;
  }
  if (state.submitted) {
    $('done-text').textContent = 'Your answers were saved. You can close this page.';
    return;
  }
  $('done-text').textContent = 'Submitting your answers…';
  $('done-error').hidden = true;
  for (let i = 0; i < SUBMIT_TRIES; i++) {
    if (await submit()) {
      state.submitted = true;
      saveState();
      $('done-text').textContent = 'Your answers were saved. You can close this page.';
      return;
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  $('done-text').textContent = '';
  $('done-error').textContent = 'Your answers could not be sent (network problem?). Please reload this page in a minute to try again; your answers are kept.';
  $('done-error').hidden = false;
}

// Going back keeps the answers on that screen; changing them replaces its record, since
// nothing is sent before the final submit.
function prev() {
  if (state.pos === 0) return;
  const item = state.seq[state.pos];
  item.current.ms += Date.now() - screenStart;
  state.pos -= 1;
  saveState();
  renderItem();
}

function download() {
  const blob = new Blob([JSON.stringify(Object.values(state.answers), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `answers_slot${state.slot + 1}_${state.session}.json`;
  a.click();
}

// ---------- init ----------
async function init() {
  if (window.innerWidth < 760) $('narrow-warning').hidden = false;
  study = await (await fetch('study.json', { cache: 'no-store' })).json();
  state = loadState();
  if (state && state.version !== study.version) state = null;
  if (state && PREVIEW && new URLSearchParams(location.search).has('s')
      && +new URLSearchParams(location.search).get('s') - 1 !== state.slot) state = null;
  if (state && state.done) return showDone();
  if (state) $('start').textContent = 'Continue';
  $('start').addEventListener('click', start);
  $('slider').addEventListener('input', (e) => setTurn(+e.target.value));
  const step = (d) => {
    const slider = $('slider');
    const t = Math.min(Math.max(+slider.value + d, 1), study.n_turns);
    slider.value = t;
    setTurn(t);
  };
  $('step').addEventListener('click', () => step(1));
  $('step-back').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', next);
  $('prev').addEventListener('click', prev);
  $('download').addEventListener('click', download);
}
init();
