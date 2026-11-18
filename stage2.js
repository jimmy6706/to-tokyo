(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  async function api(path, body) {
    const response = await fetch('/api/' + path, body === undefined ? {cache:'no-store'} : {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
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
  const hashCode = ['join','read'].map(key => new URLSearchParams(location.hash.slice(1)).get(key)).find(Boolean);
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
  const role = document.body.dataset.tripServer;
  if (!role) return;

  const kindList = {personal:'개인별 준비',shared:'공동 준비',todo:'남은 할 일'};
  const legacy = new Map(taskList.map(([id,title,stage,detail,links]) => ['legacy-' + id,{id,title,stage,detail,links}]));
  const dateStamp = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const slot = byId('shared-prep');
  const useful = byId('useful');
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
  const dateLabel = id => days.find(day=>day.id === id)?.date || id;
  function notesHere(day,visit) {
    const key = noteKey(day,visit);
    return (state?.notes || []).filter(note => note.place === placeKey(visit) && (!note.visit || note.visit === key));
  }
  function currentCheck(item, member = self()) {
    return state.checks.find(check => check.item === item.id && check.person === (item.kind === 'personal' ? member : ''));
  }
  function message(text) {
    status = text;
    for (const node of document.querySelectorAll('[data-trip-status]')) {
      node.replaceChildren(el('span','',status));
      if (retry) node.append(button('다시 시도','action secondary',retry));
      if (undo) node.append(button('실행 취소','action secondary',undo));
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
    const snapshot = await api('state' + (!force && state ? '?since=' + state.version : ''));
    if (!snapshot || (state && snapshot.version < state.version)) return;
    const oldOutfits = JSON.stringify(state?.outfits);
    state = snapshot;
    renderPrep();
    for (const view of noteViews.values()) paintNotes(view);
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
    field(form,'항목 이름','title',{value:entry?.title,required:true,maxLength:120});
    field(form,'설명','detail',{value:entry?.detail,multiline:true,maxLength:600});
    if (kind === 'shared') field(form,'수량','qty',{type:'number',value:entry?.qty || 1,min:1,max:999,required:true});
    if (kind !== 'personal') field(form,'담당자','assignee',{choices:[['','미지정'],...Object.entries(state.people)],value:entry?.assignee});
    submitBar(form,() => holder.replaceChildren());
    editGuard(holder,form);
  }
  function itemRow(item, editor) {
    const row = el('li','trip-row');
    const selected = currentCheck(item);
    const banner = item.kind === 'personal'
      ? Object.keys(state.people).filter(person => currentCheck(item,person)?.done).length + '/' + Object.keys(state.people).length + '명 완료'
      : [item.kind === 'shared' ? item.qty + '개' : '',item.assignee ? displayName(item.assignee) + ' 담당' : '담당 미지정',
          selected?.done ? '완료' : '미완료'].filter(Boolean).join(' · ');
    row.append(el('h3','',item.title),el('p','trip-quiet',banner));
    if (item.detail) row.append(el('p','trip-content',item.detail));
    if (item.stage) row.append(el('p','trip-quiet','일정 상태 · ' + item.stage));
    const info = item.kind === 'personal'
      ? Object.entries(state.people).map(([person,name]) => name + ' ' + (currentCheck(item,person)?.done ? '완료' : '미완료')).join(' · ')
      : selected ? displayName(selected.by) + ' · ' + dateStamp.format(new Date(selected.updated)) : '';
    if (info) row.append(el('p','trip-quiet',info));
    if (legacy.get(item.id)?.links) addLinks(row,legacy.get(item.id).links);
    const controls = el('div','trip-controls');
    const done = button(selected?.done ? '체크 해제' : item.kind === 'personal' ? '내 준비 체크' : '완료 체크','action',() =>
      write({op:'check',id:item.id,rev:selected?.rev || 0,done:!selected?.done}));
    done.setAttribute('aria-pressed',String(!!selected?.done));
    controls.append(done,button('수정','action secondary',() => itemEditor(item,item.kind,editor)),
      button('삭제','action secondary',() => remove('item',item)));
    row.append(controls);
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
    const statusLine = el('p','trip-status');
    statusLine.dataset.tripStatus = '';
    statusLine.setAttribute('aria-live','polite');
    const toolbar = el('div','trip-toolbar');
    for (const [filter,label] of [['all','전체'],['mine','내가 할 일'],['remaining','미완료']]) {
      const control = button(label,'action secondary trip-filter',() => {
        filtering = filter;
        for (const other of toolbar.children) other.setAttribute('aria-pressed',String(other === control));
        renderPrep();
      });
      control.setAttribute('aria-pressed',String(filter === filtering));
      toolbar.append(control);
    }
    slot.append(toolbar,statusLine);
    for (const [kind,label] of Object.entries(kindList)) {
      const box = el('section','info-panel trip-section');
      const heading = el('div','trip-heading');
      const editor = el('div');
      const list = el('ul');
      const add = button('추가','action',() => itemEditor(null,kind,editor));
      heading.append(el('h2','',label),add);
      box.append(heading,editor,list);
      panels.set(kind,{list,editor,add});
      slot.append(box);
    }
    const editor = el('div');
    const add = button('링크 추가','action',() => referenceEditor(null,editor));
    useful.append(add,editor);
    panels.set('links',{list:byId('useful-links'),editor,add});
  }
  function renderPrep() {
    if (!state?.items) return;
    for (const [kind,panel] of panels) {
      if (kind === 'links') {
        const rows = state.links.map(link => {
          const li = el('li','trip-row');
          li.append(externalLink(link.title,link.url),button('수정','action secondary',() => referenceEditor(link,panel.editor)),
            button('삭제','action secondary',() => remove('link',link)));
          return li;
        });
        panel.list.replaceChildren(...rows);
        byId('useful-empty').hidden = rows.length > 0;
        continue;
      }
      const items = state.items.filter(item => item.kind === kind && (
        filtering === 'all' || (filtering === 'mine' ? kind === 'personal' || item.assignee === self()
          : kind === 'personal' ? Object.keys(state.people).some(person => !currentCheck(item,person)?.done) : !currentCheck(item)?.done)
      ));
      panel.list.replaceChildren(...(items.length ? items.map(item => itemRow(item,panel.editor)) :
        [el('li','trip-quiet','표시할 항목이 없어요.')]));
    }
  }

  function noteEditor(view,entry) {
    const {day,visit,editor} = view;
    const form = formNode(draft => {
      const key = placeKey(visit);
      const payload = {op:'note',id:entry?.id,rev:entry?.rev,place:key,
        days:days.filter(date=>date.visits.some(stop=>placeKey(stop) === key)).map(date=>date.id),
        visit:draft.get('only') === 'on' ? noteKey(day,visit) : '',text:draft.get('text'),
        suggestion:draft.get('suggestion') === 'on',pinned:draft.get('pinned') === 'on'};
      write(payload,updated => {
        offerEditUndo(payload,entry,updated);
        showSaved(form,draft,() => editor.replaceChildren());
      });
    });
    field(form,'메모','text',{value:entry?.text,multiline:true,required:true,maxLength:800});
    if (!entry) toggle(form,'이 방문 날짜에만 표시','only');
    toggle(form,'의견·제안','suggestion',entry?.suggestion);
    toggle(form,'목록에 고정','pinned',entry?.pinned);
    submitBar(form,() => editor.replaceChildren());
    editGuard(editor,form);
  }
  function paintNotes(view) {
    const {day,visit,list,badge} = view;
    const notes = notesHere(day,visit);
    const pinned = notes.filter(note => note.pinned).at(-1);
    badge.hidden = notes.length === 0;
    badge.textContent = notes.length ? '메모 ' + notes.length + '개' + (pinned ? ' · ' + pinned.text.split('\n')[0].slice(0,46) : '') : '';
    list.replaceChildren(...(notes.length ? notes.map(note => {
      const row = el('li','trip-row');
      const meta = [displayName(note.author),dateStamp.format(new Date(note.created)),
        note.visit ? dateLabel(note.visit.split('/')[0]) + ' 방문' : '공통 메모',note.suggestion ? '의견·제안' : '',note.pinned ? '고정' : ''];
      row.append(el('p','trip-quiet',meta.filter(Boolean).join(' · ')),el('p','trip-content',note.text));
      if (note.author === self()) {
        const controls = el('div','trip-controls');
        controls.append(button('수정','action secondary',() => noteEditor(view,note)),
          button('삭제','action secondary',() => remove('note',note)));
        row.append(controls);
      }
      return row;
    }) : [el('li','trip-quiet','등록된 메모가 없어요.')]));
  }
  function attachNote(day,visit,summary,body) {
    if (!day || noteViews.has(noteKey(day,visit))) return;
    const block = el('section','trip-notes');
    const editor = el('div');
    const list = el('ul');
    const badge = el('span','visit-condition');
    const view = {day,visit,list,badge,editor};
    const head = el('div','trip-heading');
    head.append(el('h3','','장소 메모'));
    if (role === 'member') {
      head.append(button('메모 추가','action',() => noteEditor(view,null)));
      const notice = el('p','trip-status');
      notice.dataset.tripStatus = '';
      notice.setAttribute('aria-live','polite');
      block.append(head,notice);
    } else {
      block.append(head);
    }
    block.append(editor,list);
    body.append(block);
    summary.querySelector('.visit-main').append(badge);
    noteViews.set(noteKey(day,visit),view);
    paintNotes(view);
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
    account.append(el('strong','',displayName(self()) + '로 참여 중'),button('로그아웃','action secondary',async () => {
      try { await api('logout',{}); location.replace('/'); } catch (error) { message(error.message); }
    }));
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
    navigator.clipboard?.writeText(url).then(() => message('링크를 복사했어요.'),() => message('선택된 주소를 복사해 주세요.'));
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
        text('메모 · ' + note.text,23,'#263f75');
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
    const latest = button('최신 일정 링크','action secondary',() =>
      write(createViewLink(day,visit),result => shareField(location.origin + '/#read=' + result.code)));
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
        const check = toggle(notesOptions,dateLabel(day.id) + ' · ' + note.text,'include',savedSelection.has(note.id));
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
    if (state?.auth.isOwner) options.append(button('일행 초대','action',() => invitationPanel(holder)));
    const viewLink = (label,selected) => button(label,'action secondary',() =>
      write(createViewLink(day,selected),result => shareField(location.origin + '/#read=' + result.code)));
    options.append(viewLink(day.date + ' 일정 보기 링크',null));
    if (visit) options.append(viewLink(visit.label + ' 장소 보기 링크',visit));
    options.append(button('요약 이미지','action secondary',() => {
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
  async function connect() {
    if (syncing) return;
    syncing = true;
    try {
      const initial = !state;
      await refresh(true);
      if (initial) {
        if (role === 'member') {
          openPrep();
          openAccount();
          renderPrep();
          if (!state.seeded) await write({op:'seed',items:[...legacy.values()].map(({id,title,stage,detail})=>({id,title,stage,detail}))});
        } else configureViewer();
        renderSchedule(currentDay);
        if (state.auth.role === 'viewer') {
          if (state.auth.visit) openVisit(state.auth.visit.split('/').pop());
          $('dates').hidden = true;
        }
        byId('trip-connection')?.remove();
      }
      retry = null;
      message('저장소에 연결됨');
    } catch (error) {
      retry = connect;
      message(error.status === 401 ? '세션이 끝났어요. 페이지를 새로고침해 주세요.' : '공동 저장소에 연결할 수 없어요.');
      if (!state && !byId('trip-connection')) {
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
  if (hashCode) {
    const notice = el('p','trip-status');
    byId('main').prepend(notice);
    join(hashCode,notice);
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
