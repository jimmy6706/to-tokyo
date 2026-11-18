(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  let room = null;
  async function api(path, body) {
    const options = {cache:'no-store',headers:{}};
    if (body !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    if (room) {
      options.credentials = 'omit';
      options.redirect = 'error';
      options.headers.Authorization = 'Bearer ' + (path === 'profiles' ? room.key : room.member + '.' + room.key);
    }
    const response = await fetch((room?.origin || '') + '/api/' + path, options);
    if (response.status === 204) return null;
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('공동 저장소에 연결할 수 없어요.');
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error);
      error.status = response.status;
      throw error;
    }
    return result;
  }
  const joinForm = byId('trip-join');
  const fragment = new URLSearchParams(location.hash.slice(1));
  const hashCode = ['join','read'].map(key => fragment.get(key)).find(Boolean);
  async function join(code, message) {
    message.textContent = '링크를 확인하고 있어요…';
    try {
      const result = await api('join',{code});
      const stop = result.visit?.split('.')[1]?.split('/')[1];
      history.replaceState(null,'','/' + (result.day ? '#itinerary-' + result.day + (stop ? '/' + stop : '') : ''));
      location.reload();
    } catch (error) {
      message.textContent = error.message || '연결하지 못했어요. 다시 시도해 주세요.';
    }
  }
  if (joinForm) {
    const message = byId('trip-join-message');
    const codeField = joinForm.elements.namedItem('code');
    joinForm.addEventListener('submit',event => {
      event.preventDefault();
      join(codeField.value.trim(),message);
    });
    if (hashCode) {
      codeField.value = hashCode;
      join(hashCode,message);
    }
    return;
  }
  const roomStorage = 'tokyo-yokohama-dec26-shared-room';
  const pagesRoomOrigin = location.origin === 'https://jimmy6706.github.io'
    ? 'https://trip-sync-production-a72ba7e4.up.railway.app' : '';
  function parseRoom(key, origin, member) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
    let url;
    try { url = new URL(origin); } catch { return null; }
    const local = location.protocol === 'http:' && ['localhost','127.0.0.1'].includes(location.hostname)
      && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname);
    if (url.origin !== origin || (!local && url.protocol !== 'https:')) return null;
    const chosen = people.find(person => person.id === member);
    return {key,origin,member:chosen?.id || ''};
  }
  const serverRole = document.body.dataset.tripServer;
  if (!serverRole && /^https?:$/.test(location.protocol)) {
    const saved = readLocal(roomStorage, null);
    const linked = parseRoom(fragment.get('r') ?? fragment.get('room'), fragment.get('api') ?? pagesRoomOrigin);
    if (linked) {
      room = linked.key === saved?.key && linked.origin === saved.origin
        ? parseRoom(saved.key, saved.origin, saved.member) : linked;
      // Keep the room key out of copied addresses, and retain any date or place in the link.
      saveLocal(roomStorage, room);
      const target = fragment.get('at') || '';
      const route = /^(itinerary-(16|17|18|19|20)(\/[a-z0-9-]+)?|todo|bookings|transport|trip-map)$/.test(target)
        ? '#' + target : '';
      history.replaceState(null, '', location.pathname + location.search + route);
      if (route) openLocation();
    } else if (saved) {
      room = parseRoom(saved.key, saved.origin, saved.member);
    }
  }
  const role = serverRole || (room ? 'member' : '');
  if (!role) return;
  if (room) document.body.dataset.tripServer = role;

  const kindList = {personal:'각자 준비물',shared:'공동 준비물',todo:'남은 할 일'};
  const legacy = new Map(taskList.map(([id,title,stage,detail,links]) => ['legacy-' + id,{id,title,stage,detail,links}]));
  const dateStamp = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const slot = byId('shared-prep');
  const useful = byId('useful');
  const participant = room ? el('dialog','trip-participant') : null;
  if (participant) {
    participant.id = 'trip-participant';
    participant.setAttribute('aria-labelledby','participant-title');
    participant.addEventListener('cancel',event => event.preventDefault());
    document.body.append(participant);
  }
  const feedback = el('div','trip-feedback');
  feedback.dataset.tripStatus = '';
  feedback.setAttribute('role','status');
  feedback.hidden = true;
  document.body.append(feedback);
  const filters = new Map();
  let board;
  let emptyFilter;
  let dismissUndo;
  const panels = new Map();
  const noteViews = new Map();
  let state = null;
  let filtering = 'all';
  let inflight = false;
  let retry = null;
  let undo = null;
  let status = '공동 저장소에 연결하는 중…';
  let sharedPanelRefresh = null;
  let syncing = false;
  const self = () => state?.auth.role === 'member' ? state.auth.id : '';
  const displayName = member => state?.people[member] || people.find(person => person.id === member)?.name || '';
  const placeKey = visit => visit.activity === 'lodging' && visit.title.includes('에어비앤비') ? 'airbnb' : visit.place;
  const noteKey = (day,visit) => day.id + '/' + visit.id;
  function notesHere(day,visit) {
    const key = noteKey(day,visit);
    const place = placeKey(visit);
    const notes = (state?.notes || []).filter(note => note.place === place && (!note.visit || note.visit === key));
    const override = state?.guides?.find(guide => guide.id === key);
    const text = override?.text ?? (visit.flight ? '' : visit.description);
    if (text) notes.unshift({id:key,visit:key,place,text,guide:true,rev:0,...override});
    return notes;
  }
  function currentCheck(item, member = self()) {
    return state.checks.find(check => check.item === item.id && check.person === (item.kind === 'personal' ? member : ''));
  }
  function message(text) {
    status = text;
    for (const node of document.querySelectorAll('[data-trip-status]')) {
      const quiet = ['', '저장소에 연결됨', '저장됨'].includes(status);
      node.hidden = quiet && !retry && !undo;
      node.replaceChildren(el('span','',status));
      if (retry) node.append(button('다시 시도','action secondary',retry));
      if (undo) node.append(button('실행 취소','trip-text',undo));
      if (node === feedback && !retry && status === '저장됨' && undo) {
        node.append(button('닫기','trip-text',() => { undo = null; message(status); }));
      }
    }
  }
  function formNode(action) {
    const form = el('form','trip-form');
    form.addEventListener('submit',event => {
      event.preventDefault();
      action(new FormData(form));
    });
    return form;
  }
  function field(form,label,name,options = {}) {
    const box = el('label','',label);
    let input;
    if (options.choices) {
      input = el('select');
      options.choices.forEach(([value,title]) => {
        const option = el('option','',title);
        option.value = value;
        input.append(option);
      });
    } else {
      input = el(options.multiline ? 'textarea' : 'input');
      if (!options.multiline) input.type = options.type || 'text';
      if (options.maxLength) input.maxLength = options.maxLength;
      if (options.min) input.min = options.min;
      if (options.max) input.max = options.max;
    }
    input.name = name;
    input.value = options.value ?? '';
    input.required = !!options.required;
    box.append(input);
    form.append(box);
    return input;
  }
  function toggle(form,text,name,checked = false) {
    const label = el('label','trip-toggle',text);
    const input = el('input');
    input.type = 'checkbox';
    input.name = name;
    input.checked = checked;
    label.prepend(input);
    form.append(label);
    return input;
  }
  function submitBar(form, close) {
    const bar = el('div','trip-controls');
    const save = el('button','action','저장');
    save.type = 'submit';
    bar.append(save,button('취소','action secondary',close));
    form.append(bar);
  }
  function editGuard(holder, form) {
    holder.replaceChildren(form);
    form.querySelector(':is(input,textarea,select)')?.focus();
  }
  function showSaved(form,draft,after) {
    if (JSON.stringify([...new FormData(form)]) === JSON.stringify([...draft])) after();
  }
  async function refresh(force = false) {
    let snapshot = await api('state' + (!force && state ? '?since=' + state.version : ''));
    if (snapshot?.auth.role === 'member' && !snapshot.seeded) {
      const items = [...legacy.values()].map(({id,title,stage,detail}) => ({id,title,stage,detail}));
      await api('action',{op:'seed',items,requestId:crypto.randomUUID()});
      snapshot = await api('state');
    }
    if (!snapshot || (state && snapshot.version < state.version)) return;
    const oldOutfits = JSON.stringify(state?.outfits);
    state = snapshot;
    renderPrep();
    for (const view of noteViews.values()) paintNotes(view);
    if (board) paintNotes(board);
    if (oldOutfits !== JSON.stringify(state.outfits)) {
      refreshFaces();
      if (byId('profile').open) syncProfile();
      renderActors();
    }
    if (sharedPanelRefresh) sharedPanelRefresh();
  }
  async function write(payload, after, requestId = crypto.randomUUID()) {
    if (inflight) return;
    inflight = true;
    retry = null;
    undo = null;
    message('저장 중…');
    let result;
    try {
      result = await api('action',{...payload,requestId});
    } catch (error) {
      inflight = false;
      if (!error.status || error.status >= 500) {
        retry = () => write(payload,after,requestId);
        message('연결 문제로 저장을 확인하지 못했어요. 입력을 유지했어요.');
      } else {
        if (error.status === 409 || error.status === 404) await refresh(true).catch(() => {});
        message(error.message);
      }
      return;
    }
    inflight = false;
    after?.(result);
    try {
      await refresh(true);
      message('저장됨');
      clearTimeout(dismissUndo);
      if (undo) {
        const lastUndo = undo;
        dismissUndo = setTimeout(() => {
          if (undo === lastUndo && status === '저장됨') { undo = null; message(status); }
        },10000);
      }
    } catch {
      retry = connect;
      message('저장됐어요. 최신 내용을 불러오지 못했어요.');
    }
  }
  function remove(scope,value) {
    write({op:'remove',scope,id:value.id,rev:value.rev},removed => {
      undo = () => write({op:'restore',scope,id:removed.id,rev:removed.rev},() => { undo = null; });
    });
  }
  function offerEditUndo(payload, old, updated) {
    if (old) undo = () => write({...payload,...old,rev:updated.rev},() => { undo = null; });
  }

  function itemEditor(entry,kind,holder) {
    const form = formNode(draft => {
      const payload = {op:'item',id:entry?.id,rev:entry?.rev,kind,title:draft.get('title'),detail:draft.get('detail'),
        qty:kind === 'shared' ? Number(draft.get('qty')) : 1,assignee:draft.get('assignee') || ''};
      write(payload,updated => {
        offerEditUndo(payload,entry,updated);
        showSaved(form,draft,() => holder.replaceChildren());
      });
    });
    field(form,'이름','title',{value:entry?.title,required:true,maxLength:120});
    const extra = el('details','item-extra');
    extra.open = !!entry;
    extra.append(el('summary','',kind === 'personal' ? '설명' : kind === 'shared' ? '설명 · 수량 · 담당' : '설명 · 담당'));
    field(extra,'설명','detail',{value:entry?.detail,multiline:true,maxLength:600});
    if (kind === 'shared') field(extra,'수량','qty',{type:'number',value:entry?.qty || 1,min:1,max:999,required:true});
    if (kind !== 'personal') field(extra,'담당자','assignee',{choices:[['','미지정'],...Object.entries(state.people)],value:entry?.assignee});
    form.append(extra);
    submitBar(form,() => holder.replaceChildren());
    editGuard(holder,form);
  }
  function rowActions(name, edit, erase) {
    const menu = el('details','row-menu');
    const toggle = el('summary');
    toggle.setAttribute('aria-label', name + ' 관리');
    const choices = el('div','row-options');
    for (const [label,action] of [['수정',edit],['삭제',erase]]) {
      choices.append(button(label,'',() => { menu.open = false; action(); }));
    }
    menu.addEventListener('keydown',event => {
      if (event.key === 'Escape') { menu.open = false; toggle.focus(); }
    });
    menu.append(toggle,choices);
    return menu;
  }
  document.addEventListener('click',event => {
    for (const menu of document.querySelectorAll('.row-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });

  function itemRow(item, editor) {
    const row = el('li','pack-row');
    const selected = currentCheck(item);
    const box = el('input','pack-check');
    box.type = 'checkbox';
    box.checked = !!selected?.done;
    box.setAttribute('aria-label', item.title + ' 완료');
    box.addEventListener('change',() => {
      const done = box.checked;
      box.checked = !!selected?.done;
      write({op:'check',id:item.id,rev:selected?.rev || 0,done});
    });
    const copy = el('div','pack-copy');
    const title = el('label','pack-title',item.title);
    box.id = 'pack-' + item.id;
    title.htmlFor = box.id;
    copy.append(title);
    if (item.kind === 'shared' && item.qty > 1) copy.append(el('span','pack-meta','× ' + item.qty));
    if (item.assignee) copy.append(el('span','pack-meta',displayName(item.assignee) + ' 담당'));
    if (item.detail) copy.append(el('p','pack-detail',item.detail));
    if (legacy.get(item.id)?.links) addLinks(copy,legacy.get(item.id).links);
    row.append(box,copy,rowActions(item.title,() => itemEditor(item,item.kind,editor),() => remove('item',item)));
    return row;
  }
  function referenceEditor(entry,holder) {
    const form = formNode(draft => {
      const payload = {op:'link',id:entry?.id,rev:entry?.rev,title:draft.get('title'),url:draft.get('url')};
      write(payload,updated => {
        offerEditUndo(payload,entry,updated);
        showSaved(form,draft,() => holder.replaceChildren());
      });
    });
    field(form,'제목','title',{value:entry?.title,required:true,maxLength:120});
    field(form,'링크 주소','url',{value:entry?.url,type:'url',required:true,maxLength:2048});
    submitBar(form,() => holder.replaceChildren());
    editGuard(holder,form);
  }
  function openPrep() {
    slot.hidden = false;
    slot.classList.add('trip-sets');
    const toolbar = el('div','trip-toolbar');
    toolbar.setAttribute('role','group');
    toolbar.setAttribute('aria-label','준비물 필터');
    for (const [filter,label] of [['all','준비 중'],['mine','내 담당'],['done','완료함']]) {
      const count = el('span','filter-count');
      const control = button(label,'action secondary trip-filter',() => {
        filtering = filter;
        renderPrep();
      });
      control.append(count);
      filters.set(filter,{control,count});
      toolbar.append(control);
    }
    emptyFilter = el('p','pack-empty empty-filter');
    emptyFilter.hidden = true;
    slot.append(toolbar,emptyFilter);
    for (const [kind,label] of Object.entries(kindList)) {
      const box = el('section','info-panel trip-section');
      box.dataset.kind = kind;
      const heading = el('div','trip-heading');
      const editor = el('div');
      const list = el('ul');
      const add = button('＋ 추가','trip-text',() => itemEditor(null,kind,editor));
      add.setAttribute('aria-label',label + ' 추가');
      const title = el('h2','',label);
      heading.append(title,add);
      box.append(heading,editor,list);
      panels.set(kind,{box,title,list,editor,add});
      slot.append(box);
    }
    const boardBox = el('section','info-panel trip-section');
    board = noteSection(boardBox);
    slot.append(boardBox);
    const editor = el('div');
    const add = button('＋ 링크 추가','trip-text',() => referenceEditor(null,editor));
    useful.hidden = false;
    useful.open = true;
    useful.append(add,editor);
    panels.set('links',{list:byId('useful-links'),editor});
    paintNotes(board);
  }
  function renderPrep() {
    if (!state?.items || !filters.size) return;
    const completed = state.items.filter(item => currentCheck(item)?.done);
    const pending = state.items.filter(item => !currentCheck(item)?.done);
    const mine = pending.filter(item => item.kind === 'personal' || item.assignee === self());
    const groups = {all:pending,mine,done:completed};
    for (const [filter,{control,count}] of filters) {
      control.setAttribute('aria-pressed',String(filter === filtering));
      count.textContent = groups[filter].length;
    }
    emptyFilter.textContent = filtering === 'done' ? '아직 완료한 항목이 없어요.' : '지금 내가 맡은 항목이 없어요.';
    emptyFilter.hidden = filtering === 'all' || groups[filtering].length > 0;
    if (board) board.block.hidden = filtering !== 'all';
    useful.hidden = filtering !== 'all';
    for (const [kind,panel] of panels) {
      if (kind === 'links') {
        const rows = state.links.map(link => {
          const li = el('li','reference-row');
          const anchor = el('a','reference-link');
          anchor.href = link.url;
          anchor.rel = 'noopener noreferrer';
          anchor.target = '_blank';
          anchor.title = link.url;
          anchor.append(el('strong','',link.title),el('span','reference-url',link.url.replace(/^https?:\/\//,'')));
          li.append(anchor,rowActions(link.title,() => referenceEditor(link,panel.editor),() => remove('link',link)));
          return li;
        });
        panel.list.replaceChildren(...rows);
        byId('useful-empty').hidden = rows.length > 0;
        continue;
      }
      const items = groups[filtering].filter(item => item.kind === kind);
      panel.title.textContent = kind === 'todo' && filtering === 'done' ? '완료한 할 일' : kindList[kind];
      panel.box.dataset.completed = filtering === 'done';
      panel.box.hidden = !items.length && filtering !== 'all';
      panel.add.hidden = filtering === 'done';
      const empty = filtering === 'done' ? '완료한 항목이 없어요.' : filtering === 'mine' ? '내 담당 항목이 없어요.' : '준비할 항목이 없어요.';
      panel.list.replaceChildren(...(items.length ? items.map(item => itemRow(item,panel.editor)) : [el('li','pack-empty',empty)]));
    }
  }

  function closeNoteEditor(view) {
    view.editor.replaceChildren();
    view.add.hidden = false;
    view.add.focus({preventScroll:true});
  }
  function noteEditor(view,entry) {
    const {visit,editor} = view;
    const form = formNode(draft => {
      const place = visit ? placeKey(visit) : 'trip-board';
      const payload = entry?.guide ? {op:'guide',visit:entry.visit,rev:entry.rev,text:draft.get('text')} : {op:'note',id:entry?.id,rev:entry?.rev,place,
        days:visit ? days.filter(date=>date.visits.some(stop=>placeKey(stop) === place)).map(date=>date.id) : [],
        visit:entry?.visit || '',text:draft.get('text')};
      write(payload,updated => {
        offerEditUndo(payload,entry,updated);
        showSaved(form,draft,() => closeNoteEditor(view));
      });
    });
    form.classList.add('note-editor');
    const input = el('textarea');
    input.name = 'text';
    input.rows = 3;
    input.required = true;
    input.maxLength = 800;
    input.setAttribute('aria-label',visit ? visit.label + ' 메모' : '공동 메모');
    input.placeholder = visit ? '추천 메뉴, 가격, 들를 때 기억할 것…' : '일행과 함께 기억할 내용을 적어요…';
    input.value = entry?.text || '';
    input.addEventListener('keydown',event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault(); form.requestSubmit();
      }
    });
    form.append(input);
    submitBar(form,() => closeNoteEditor(view));
    view.add.hidden = true;
    editGuard(editor,form);
  }
  function paintNotes(view) {
    const {day,visit,list,badge} = view;
    const notes = visit ? notesHere(day,visit) : state.notes.filter(note => note.place === 'trip-board');
    if (badge) {
      const contributed = notes.filter(note => !note.guide || note.rev > 0).length;
      badge.hidden = !contributed;
      badge.textContent = '메모 ' + contributed;
    }
    view.block.hidden = visit ? role === 'viewer' && !notes.length : filtering !== 'all';
    list.replaceChildren(...notes.map(note => {
      const row = el('li','note-row');
      const meta = el('div','note-meta');
      meta.append(el('strong','',note.guide ? '기본 메모' : displayName(note.author)));
      if (note.guide && note.by) meta.append(el('span','',displayName(note.by)));
      const stamp = (label,value) => {
        const time = el('time','',label + ' ' + dateStamp.format(new Date(value)));
        time.dateTime = value;
        return time;
      };
      if (note.created) meta.append(stamp('작성',note.created));
      if (note.updated && note.updated !== note.created) meta.append(stamp('수정',note.updated));
      row.append(meta,el('p','note-text',note.text));
      if (role === 'member' && (note.guide || note.author === self())) {
        const erase = () => {
          if (!note.guide) return remove('note',note);
          const payload = {op:'guide',visit:note.visit,rev:note.rev,text:''};
          write(payload,updated => offerEditUndo(payload,note,updated));
        };
        row.append(rowActions(note.guide ? '기본 메모' : '메모',() => noteEditor(view,note),erase));
      }
      return row;
    }));
  }
  function noteSection(block,day,visit) {
    const editor = el('div');
    const list = el('ul','note-list');
    const badge = visit ? el('span','note-badge') : null;
    const head = el('div','trip-heading');
    head.append(el(visit ? 'h3' : 'h2','',visit ? '장소 메모' : '공동 메모'));
    const view = {block,day,visit,list,badge,editor};
    if (role === 'member') {
      view.add = button('＋ 메모 쓰기','trip-text',() => noteEditor(view,null));
      head.append(view.add);
    }
    block.append(head,list,editor);
    return view;
  }
  function attachNote(day,visit,meta,body) {
    if (!state || !day || noteViews.has(noteKey(day,visit))) return;
    const block = el('section','trip-notes');
    const view = noteSection(block,day,visit);
    body.append(block);
    meta.append(view.badge);
    noteViews.set(noteKey(day,visit),view);
    paintNotes(view);
    return true;
  }

  function syncProfile() {
    showProfilePortrait();
    for (const control of byId('outfit-grid').children) {
      control.setAttribute('aria-pressed',String(control.dataset.outfit === outfit(profilePerson)));
      control.disabled = self() !== profilePerson.id;
    }
  }
  function openAccount() {
    const account = byId('profile-account');
    account.hidden = false;
    const accountAction = room ? button('프로필 전환','action secondary',() => {
      saveLocal(roomStorage,{...room,member:'',outfits:state.outfits});
      location.reload();
    }) : button('로그아웃','action secondary',async () => {
      try { await api('logout',{}); location.replace('/'); } catch (error) { message(error.message); }
    });
    account.append(accountAction);
    const others = el('details','crew-directory');
    others.append(el('summary','','일행 프로필 보기'));
    const picker = byId('crew-picker');
    picker.before(others);
    others.append(picker);
    byId('profile').append(others,account);
    refreshFaces();
    const notice = byId('profile-sync');
    notice.hidden = false;
    notice.dataset.tripStatus = '';
  }

  function shareField(url) {
    const field = byId('share-url');
    field.value = url;
    field.hidden = false;
    field.focus();
    field.select();
    message('선택된 주소를 복사해 주세요.');
    navigator.clipboard?.writeText(url).then(() => message('링크를 복사했어요.'),() => {});
  }
  function roomLink(target = '') {
    const url = new URL(location.pathname,location.origin);
    const params = new URLSearchParams(room.origin === pagesRoomOrigin
      ? {r:room.key} : {room:room.key,api:room.origin});
    if (target) params.set('at',target);
    url.hash = params;
    return url.href;
  }
  function createViewLink(day,visit) {
    return {op:'invite',kind:'viewer',day:day.id,visit:visit ? noteKey(day,visit) : '',place:visit ? placeKey(visit) : ''};
  }
  function invitationPanel(container) {
    const editor = formNode(data => write({op:'invite',kind:'member',member:data.get('member')},result => {
      shareField(location.origin + '/#join=' + result.code);
    }));
    field(editor,'초대할 일행','member',{choices:Object.entries(state.people),value:self(),required:true});
    const create = el('button','action','초대 링크 만들기');
    create.type = 'submit';
    editor.append(create);
    const list = el('ul');
    container.replaceChildren(el('p','trip-quiet','초대 링크는 3일 동안 유효하며 한 번만 쓸 수 있어요.'),editor,list);
    sharedPanelRefresh = () => {
      list.replaceChildren(...state.invitations.map(invite => {
        const entry = el('li','trip-row');
        entry.append(el('p','trip-quiet',displayName(invite.member) + ' · ' + dateStamp.format(new Date(invite.expires)) + ' 만료'),
          button('초대 회수','action secondary',() => write({op:'revoke',id:invite.id})));
        return entry;
      }));
    };
    sharedPanelRefresh();
  }

  function lines(ctx,text,width) {
    const result = [];
    for (const paragraph of String(text).split('\n')) {
      let current = '';
      for (const char of paragraph) {
        if (ctx.measureText(current + char).width > width && current) {
          result.push(current.trimEnd());
          current = char.trimStart();
        } else current += char;
      }
      result.push(current);
    }
    return result;
  }
  function summaryImage(day,visits,selection) {
    const image = canvas(820,200);
    const ctx = image.getContext('2d');
    const operations = [];
    let y = 48;
    function text(content,size,color = '#20283a',weight = 500) {
      const font = weight + ' ' + size + 'px system-ui, sans-serif';
      ctx.font = font;
      for (const row of lines(ctx,content,730)) {
        operations.push({row, y, font, color});
        y += Math.round(size * 1.38);
      }
    }
    text(day.date + ' ' + day.weekday + ' · ' + day.title,44,'#263f75',800);
    text('생성 ' + new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Tokyo',dateStyle:'medium',timeStyle:'short'}).format(new Date()),22,'#565e69');
    y += 18;
    visits.forEach((visit,index) => {
      text((index ? '↓  ' : '') + visit.displayTime + '  ' + visit.label,30,'#20283a',800);
      if (visit.condition && visit.activity !== 'lodging') text(visit.condition,25,'#565e69');
      for (const note of selection.filter(note=>note.place === placeKey(visit) && (!note.visit || note.visit === noteKey(day,visit)))) {
        text((note.guide ? '기본 메모' : displayName(note.author)) + ' · ' + note.text,23,'#263f75');
      }
      y += 16;
    });
    image.height = y + 15;
    ctx.fillStyle = '#f7f3e9';
    ctx.fillRect(0,0,image.width,image.height);
    ctx.textBaseline = 'top';
    for (const operation of operations) {
      ctx.font = operation.font;
      ctx.fillStyle = operation.color;
      ctx.fillText(operation.row,44,operation.y);
    }
    return image;
  }
  function imagePanel(holder,day,visit) {
    const config = el('div','trip-form');
    const choices = day.visits.map((stop,index)=>[String(index),stop.label]);
    const selected = visit ? day.visits.indexOf(visit) : 0;
    const first = field(config,'시작 장소','first',{choices,value:String(selected)});
    const last = field(config,'마지막 장소','last',{choices,value:String(visit ? selected : choices.length - 1)});
    const notesOptions = el('div');
    const preview = el('div');
    const actions = el('div','trip-controls');
    const notice = el('p','trip-quiet','선택한 메모만 이미지에 담겨요.');
    const savedSelection = new Set();
    let frame = null;
    let file = null;
    let version = 0;
    const download = button('이미지 저장','action',() => {
      const link = el('a');
      const url = URL.createObjectURL(file);
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url),5000);
    });
    const native = button('이미지 공유','action secondary',async () => {
      try { await navigator.share({files:[file],title:day.date + ' ' + day.title,text:'생성 시점의 여행 일정입니다.'}); }
      catch (error) { if (error.name !== 'AbortError') message('이미지 저장을 사용해 주세요.'); }
    });
    const latest = button('최신 일정 링크','action secondary',() => {
      if (room) shareField(roomLink('itinerary-' + day.id + (visit ? '/' + visit.id : '')));
      else write(createViewLink(day,visit),result => shareField(location.origin + '/#read=' + result.code));
    });
    actions.append(download,native,latest);
    holder.replaceChildren(config,notice,preview,actions);
    config.append(notesOptions);
    function draw() {
      const stamp = ++version;
      const from = Number(first.value);
      const to = Number(last.value);
      const stops = day.visits.slice(from,Math.max(from,to)+1);
      const candidate = new Map();
      stops.filter(stop=>stop.activity !== 'lodging').forEach(stop => notesHere(day,stop).forEach(note=>candidate.set(note.id,note)));
      notesOptions.replaceChildren();
      for (const note of candidate.values()) {
        const check = toggle(notesOptions,(note.guide ? '기본 메모' : displayName(note.author)) + ' · ' + note.text,'include',savedSelection.has(note.id));
        check.addEventListener('change',() => {
          if (check.checked) savedSelection.add(note.id);
          else savedSelection.delete(note.id);
          draw();
        });
      }
      frame = summaryImage(day,stops,[...candidate.values()].filter(note=>savedSelection.has(note.id)));
      frame.classList.add('trip-preview');
      frame.removeAttribute('aria-hidden');
      frame.setAttribute('role','img');
      frame.setAttribute('aria-label','요약 이미지 미리보기');
      preview.replaceChildren(frame);
      file = null;
      download.disabled = native.disabled = true;
      frame.toBlob(blob => {
        if (stamp !== version || !blob) return;
        file = new File([blob],'도쿄-요코하마-12-' + day.id + '.png',{type:'image/png'});
        native.hidden = !navigator.canShare?.({files:[file]});
        download.disabled = native.disabled = false;
      },'image/png');
    }
    first.addEventListener('change',() => {
      if (Number(first.value) > Number(last.value)) last.value = first.value;
      draw();
    });
    last.addEventListener('change',() => {
      if (Number(last.value) < Number(first.value)) first.value = last.value;
      draw();
    });
    draw();
  }
  function share(day,visit) {
    const options = byId('share-options');
    const holder = byId('share-panel');
    const statusLine = byId('share-status');
    byId('share-title').textContent = '여행 공유';
    statusLine.dataset.tripStatus = '';
    byId('share-url').hidden = true;
    holder.replaceChildren();
    options.replaceChildren();
    sharedPanelRefresh = null;
    if (room) {
      options.append(button('일행 링크','action',() => shareField(roomLink())));
      const target = 'itinerary-' + day.id;
      options.append(button(day.date + ' 일정 링크','action secondary',() => shareField(roomLink(target))));
      if (visit) options.append(button(visit.label + ' 장소 링크','action secondary',() => shareField(roomLink(target + '/' + visit.id))));
    } else if (state) {
      if (state.auth.isOwner) options.append(button('일행 초대','action',() => invitationPanel(holder)));
      const viewLink = (label,selected) => button(label,'action secondary',() =>
        write(createViewLink(day,selected),result => shareField(location.origin + '/#read=' + result.code)));
      options.append(viewLink(day.date + ' 일정 보기 링크',null));
      if (visit) options.append(viewLink(visit.label + ' 장소 보기 링크',visit));
    }
    if (state) options.append(button('요약 이미지','action secondary',() => {
      sharedPanelRefresh = null;
      imagePanel(holder,day,visit);
    }));
    message(status);
    byId('share-dialog').showModal();
  }

  function configureViewer() {
    const auth = state.auth;
    const date = days.find(day => day.id === auth.day) || days[0];
    const stopId = auth.visit?.split('.')[1]?.split('/')[1];
    for (let index = 0; index < dateButtons.length; index++) dateButtons[index].hidden = days[index] !== date;
    const banner = el('p','trip-read-banner','읽기 전용으로 공유된 일정과 장소 메모입니다.');
    byId('schedule-view').prepend(banner);
    const reset = () => {
      selectDay(date,false);
      if (stopId) openVisit(stopId);
      $('dates').hidden = true;
    };
    reset();
    window.addEventListener('hashchange',reset);
  }
  function showParticipant() {
    const title = el('h1','','여행 프로필');
    title.id = 'participant-title';
    title.tabIndex = -1;
    const panel = el('div','participant-panel');
    const notice = el('p','trip-status');
    notice.setAttribute('role','status');
    notice.dataset.tripStatus = '';
    const picker = el('div','profile-choices');
    const tiles = new Map();
    const cached = readLocal(roomStorage,null);
    const cachedOutfits = cached?.key === room.key && cached.origin === room.origin ? cached.outfits : [];
    const draw = outfits => {
      for (const [person,tile] of tiles) {
        const selected = outfits?.find(entry => entry.id === person.id)?.outfit;
        tile.replaceChildren(portrait(person,Object.hasOwn(costumes,selected) ? selected : 'base',false,true));
      }
    };
    for (const person of people) {
      const control = button('', 'profile-choice', async () => {
        if (syncing) return;
        room.member = person.id;
        await connect();
      });
      const tile = el('span','profile-tile');
      tile.style.backgroundColor = person.field;
      tiles.set(person,tile);
      control.append(tile,el('strong','',person.name));
      picker.append(control);
    }
    draw(cachedOutfits);
    api('profiles').then(draw).catch(() => {});
    panel.append(el('p','profile-trip','도쿄·요코하마 여행'),title,picker,notice);
    participant.replaceChildren(panel);
    if (!participant.open) { participant.showModal(); title.focus(); }
    message(status);
  }
  async function connect() {
    if (syncing) return;
    syncing = true;
    if (!state) message('공동 저장소에 연결하는 중…');
    try {
      const initial = !state;
      await refresh(true);
      if (initial) {
        if (role === 'member') {
          openPrep();
          openAccount();
          renderPrep();
        } else configureViewer();
        renderSchedule(currentDay);
        if (state.auth.role === 'viewer') {
          if (state.auth.visit) openVisit(state.auth.visit.split('/').pop());
          $('dates').hidden = true;
        }
        byId('trip-connection')?.remove();
      }
      if (room) {
        saveLocal(roomStorage,room);
        participant.close();
      }
      retry = null;
      message('저장소에 연결됨');
    } catch (error) {
      retry = connect;
      message(error.status === 401 ? error.message : '공동 저장소에 연결할 수 없어요.');
      if (!state && room) showParticipant();
      else if (!state && !byId('trip-connection')) {
        const box = el('div','trip-status');
        box.id = 'trip-connection';
        box.dataset.tripStatus = '';
        byId('main').prepend(box);
        message(status);
      }
    } finally {
      syncing = false;
    }
  }
  const renderOriginal = renderSchedule;
  renderSchedule = day => {
    noteViews.clear();
    const active = activeVisit;
    renderOriginal(day);
    if (active) {
      const visit = byId('visit-' + active);
      if (visit) visit.open = true;
    }
    message(status);
  };
  window.tripSync = {
    outfit:person => state?.outfits?.find(profile=>profile.id === person)?.outfit || 'base',
    member:self,
    canDress:person => self() === person,
    saveOutfit(person,outfit) {
      if (self() === person) write({op:'outfit',outfit});
    },
    attachNote,
    share
  };
  byId('share-dialog').addEventListener('close',() => { sharedPanelRefresh = null; });
  if (hashCode && serverRole) {
    const notice = el('p','trip-status');
    byId('main').prepend(notice);
    join(hashCode,notice);
  } else if (room && !room.member) {
    status = '';
    useful.hidden = true;
    showParticipant();
  } else connect();

  setInterval(async () => {
    if (document.hidden || inflight || syncing || !state) return;
    try {
      await refresh();
      if (retry === connect) {
        retry = null;
        message('저장소에 연결됨');
      }
    } catch {
      if (!retry) {
        retry = connect;
        message('연결 끊김 · 이전 내용을 표시하고 있어요.');
      }
    }
  },3000);
})();
