(() => {
  'use strict';
  const page = document.getElementById('page-coach');
  if (!page) return;
  const feedback = document.getElementById('coachFeedback');
  const inviteResult = document.getElementById('coachInviteResult');
  const invitationList = document.getElementById('coachInvitations');
  const relationshipRoot = document.getElementById('coachRelationships');
  const consent = document.getElementById('coachConsent');
  const applicationForm = document.getElementById('coachApplicationForm');
  const applicationStatus = document.getElementById('coachApplicationStatus');
  const trainerArea = document.getElementById('coachTrainerArea');
  const clientSections = document.getElementById('coachClientSections');
  const connectSection = document.getElementById('coachConnectSection');
  const relationshipsDisclosure = document.getElementById('coachRelationshipsDisclosure');
  const relationshipCount = document.getElementById('coachRelationshipCount');
  const relationshipHint = document.getElementById('coachRelationshipHint');
  const trainerClientList = document.getElementById('coachTrainerClients');
  const trainerClientDetail = document.getElementById('coachTrainerClientDetail');
  const trainerClientCount = document.getElementById('coachClientCount');
  const trainerClientSearch = document.getElementById('coachClientSearch');
  const trainerHome = document.getElementById('coachTrainerHome');
  const applicationDisclosure = document.getElementById('coachApplicationDisclosure');
  const modeIntro = document.getElementById('coachModeIntro');
  const programList = Array.isArray(window.RITM_PROGRAM_LIBRARY?.programs) ? window.RITM_PROGRAM_LIBRARY.programs : [];
  const exerciseList = Array.isArray(window.RITM_PROGRAM_LIBRARY?.exercises) ? window.RITM_PROGRAM_LIBRARY.exercises : [];
  const scopeLabels = { workouts: 'Тренировки', progress: 'Прогресс и вес', nutrition: 'Сводка питания', nutritionGoals: 'Предложения КБЖУ', programs: 'Назначение готовых программ' };
  let inviteToken = '';
  let invitationPreview = null;
  let trainerMode = document.body.dataset.trainerMode === 'true';
  let applicationBadgeTimer = null;
  const clientTabs = new Map();
  let latestOverview = null;
  let latestLogin = '';
  let selectedTrainerClientLinkId = '';
  let clientLinkCountBeforeLoad = null;

  function setTrainerModeUI(enabled) {
    trainerMode = Boolean(enabled);
    clientSections?.classList.toggle('hidden', trainerMode);
    trainerArea?.classList.toggle('hidden', !trainerMode);
    if (modeIntro) modeIntro.textContent = trainerMode
      ? 'Кабинет для работы с подопечными: планы, тренировки, питание и обратная связь в пределах разрешений клиента.'
      : 'Подключи профиль к тренеру по приглашению или подай заявку на тренерство.';
    const menuLabel = document.querySelector('#coachMenuItem span:nth-child(2)');
    if (menuLabel) menuLabel.textContent = trainerMode ? 'Тренерская' : 'Тренер и клиент';
    const menuIcon = document.querySelector('#coachMenuItem .quick-action-icon');
    if (menuIcon) menuIcon.textContent = trainerMode ? '♟' : '↔';
    const eyebrow = document.getElementById('coachPageEyebrow');
    if (eyebrow) eyebrow.textContent = trainerMode ? 'ЛИЧНЫЙ КАБИНЕТ ТРЕНЕРА' : 'СОВМЕСТНАЯ РАБОТА';
    const title = document.getElementById('coachPageTitle');
    if (title) title.textContent = trainerMode ? 'Тренерская' : 'Тренер и клиент';
  }
  window.setTrainerModeUI = setTrainerModeUI;
  setTrainerModeUI(trainerMode);

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function setFeedback(message, error = false) {
    feedback.textContent = message || '';
    feedback.classList.toggle('hidden', !message);
    feedback.classList.toggle('error', Boolean(error));
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    let body = {};
    try { body = await response.json(); } catch { /* empty response */ }
    if (!response.ok) throw new Error(body.error || 'Не удалось выполнить действие. Попробуй ещё раз.');
    return body;
  }
  function scopePayload(container) {
    const values = {};
    container.querySelectorAll('[data-coach-scope]').forEach(input => { values[input.dataset.coachScope] = input.checked; });
    return values;
  }
  function permissionPills(permissions) {
    const enabled = Object.entries(scopeLabels).filter(([key]) => permissions?.[key]).map(([, label]) => `<span>${label}</span>`);
    return enabled.length ? enabled.join('') : '<span>Тренировочные данные закрыты</span>';
  }
  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function formatDuration(value) {
    const seconds = Math.max(0, Number(value) || 0);
    if (!seconds) return '—';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return hours ? `${hours} ч ${minutes} мин` : `${minutes || 1} мин`;
  }
  function renderInvitations(items = []) {
    invitationList.innerHTML = items.length ? `<div class="eyebrow">АКТИВНЫЕ КОДЫ</div>${items.map(item => `<div class="coach-assignment"><span>Ожидает подтверждения<small>Истекает ${esc(formatDate(item.expiresAt))}</small></span><button class="coach-action secondary" type="button" data-coach-action="revoke-invite" data-id="${esc(item.id)}">Отменить</button></div>`).join('')}` : '<small class="muted">Активных приглашений нет.</small>';
  }
  function renderMessages(link) {
    const messages = link.messages || [];
    return `<div class="coach-subsection"><div class="eyebrow">ОБРАТНАЯ СВЯЗЬ</div><div class="coach-thread">${messages.length ? messages.map(message => `<div class="coach-message${message.from === link._myLogin ? ' mine' : ''}">${esc(message.text)}<small>${message.from === link._myLogin ? 'Ты' : esc(link.peer.name || link.peer.login)} · ${esc(formatDate(message.at))}</small></div>`).join('') : '<div class="coach-empty">Сообщений пока нет. Используйте эту переписку для коротких вопросов и комментариев.</div>'}</div><form class="coach-message-form" data-coach-message-form data-link-id="${esc(link.id)}"><input class="coach-input" name="text" maxlength="1200" placeholder="Написать сообщение…" required><button class="coach-action" type="submit">Отправить</button></form></div>`;
  }
  function renderAssignments(link) {
    const list = link.assignments || [];
    const rows = list.length ? list.map(item => {
      const status = item.status === 'accepted' ? 'Добавлена в твои программы' : item.status === 'declined' ? 'Отклонена' : item.status === 'cancelled' ? 'Отменена из-за изменения разрешений' : 'Ждёт твоего решения';
      return `<div class="coach-assignment"><span>${esc(item.programName || 'Программа')}<small>${esc(status)} · ${esc(formatDate(item.createdAt))}</small></span>${link.role === 'client' && item.status === 'pending' ? `<span class="coach-inline"><button class="coach-action" type="button" data-coach-action="accept-program" data-id="${esc(item.id)}" data-link-id="${esc(link.id)}">Добавить</button><button class="coach-action secondary" type="button" data-coach-action="decline-program" data-id="${esc(item.id)}" data-link-id="${esc(link.id)}">Отклонить</button></span>` : ''}</div>`;
    }).join('') : '<small class="muted">Назначений пока нет.</small>';
    const select = programList.map(program => `<option value="${esc(program.id)}">${esc(program.name)}</option>`).join('');
    const form = link.role === 'trainer' && link.permissions.programs ? `<form class="coach-subsection" data-coach-program-form data-link-id="${esc(link.id)}"><label class="coach-field-label">Предложить готовую программу</label><div class="coach-inline"><select class="coach-input" name="programId">${select}</select><button class="coach-action" type="submit">Назначить</button></div><small class="muted">Программа появится у клиента только после его согласия.</small></form>` : '';
    return `<div class="coach-subsection"><div class="eyebrow">ПРОГРАММЫ</div>${rows}${form}</div>`;
  }
  function renderWorkoutAssignments(link) {
    const list = link.workoutAssignments || [];
    const rows = list.length ? '<div class="coach-recommendations">' + list.slice().reverse().map(item => {
      const status = item.completedSessionId ? 'Выполнена' : item.status === 'pending' ? 'Ожидает решения' : item.status === 'accepted' ? link.role === 'trainer' ? 'Принята · добавлена в программы клиента' : 'Принята · добавлена в мои программы' : item.status === 'cancelled' ? 'Отменена из-за изменения разрешений' : 'Отклонена';
      const checkIn = item.checkIn;
      const feeling = checkIn ? ({ good: 'Хорошее', okay: 'Нормальное', poor: 'Тяжёлое' }[checkIn.wellbeing] || '—') : '';
      const checkInSummary = checkIn ? '<div class="coach-checkin"><strong>Отзыв подопечного</strong><p>Нагрузка ' + esc(String(checkIn.effort)) + '/10 · самочувствие: ' + esc(feeling) + '</p>' + (checkIn.note ? '<p>' + esc(checkIn.note) + '</p>' : '') + (checkIn.trainerReply ? '<p><strong>Ответ тренера:</strong> ' + esc(checkIn.trainerReply) + '</p>' : link.role === 'trainer' ? '<form class="coach-checkin" data-coach-checkin-reply-form data-link-id="' + esc(link.id) + '" data-assignment-id="' + esc(item.id) + '"><label class="coach-field-label">Ответ подопечному</label><textarea class="coach-input" name="reply" rows="2" maxlength="500" required></textarea><button class="coach-action" type="submit">Отправить ответ</button></form>' : '<small class="muted">Отзыв отправлен тренеру.</small>') + '</div>' : '';
      const checkInForm = link.role === 'client' && item.completedSessionId && !checkIn ? '<form class="coach-checkin" data-coach-checkin-form data-link-id="' + esc(link.id) + '" data-assignment-id="' + esc(item.id) + '"><strong>Как прошло занятие?</strong><div class="coach-checkin-grid"><label>Нагрузка, 1–10<input class="coach-input" name="effort" type="number" min="1" max="10" value="7" required></label><label>Самочувствие<select class="coach-input" name="wellbeing"><option value="good">Хорошее</option><option value="okay">Нормальное</option><option value="poor">Тяжёлое</option></select></label></div><label class="coach-field-label">Комментарий тренеру</label><textarea class="coach-input" name="note" rows="2" maxlength="500" placeholder="Что получилось, где нужна помощь?"></textarea><button class="coach-action" type="submit">Отправить отзыв</button></form>' : '';
      return '<article class="coach-recommendation"><div class="between"><strong>' + esc(item.title) + '</strong><small>' + esc(formatDate(item.date)) + '</small></div><p>' + (item.exerciseNames?.map(esc).join(' · ') || 'Упражнения из каталога') + (item.exerciseSpecs?.[0] ? ' · ' + esc(item.exerciseSpecs[0].sets) + ' подхода × ' + esc(item.exerciseSpecs[0].reps) + ' · отдых ' + esc(item.exerciseSpecs[0].rest) : '') + '</p>' + (item.note ? '<p>' + esc(item.note) + '</p>' : '') + '<span class="coach-status">' + status + '</span>' + (item.status === 'pending' && link.role === 'client' ? '<div class="coach-inline"><button class="coach-action" type="button" data-coach-action="accept-workout" data-id="' + esc(item.id) + '" data-link-id="' + esc(link.id) + '">Принять тренировку</button><button class="coach-action secondary" type="button" data-coach-action="decline-workout" data-id="' + esc(item.id) + '" data-link-id="' + esc(link.id) + '">Отклонить</button></div>' : '') + checkInSummary + checkInForm + '</article>';
    }).join('') + '</div>' : '<div class="coach-empty">Назначенных тренировок пока нет.</div>';
    return '<div class="coach-subsection"><div class="eyebrow">ТРЕНИРОВКИ ПО ПЛАНУ</div>' + rows + '</div>';
  }  function renderWorkoutSummary(data) {
    if (!data) return '';
    const sessions = data.recent || [];
    return `<div class="coach-summary-item"><strong>${esc(String(data.count || 0))}</strong> завершённых тренировок${sessions.length ? `<br>${sessions.map(item => `${esc(formatDate(item.date))} · ${esc(item.planName)} · ${esc(formatDuration(item.durationSeconds))}`).join('<br>')}` : ''}</div>`;
  }
  function renderRecommendationList(link) {
    const items = link.recommendations || [];
    if (!items.length) return '<div class="coach-empty">Рекомендаций пока нет.</div>';
    return `<div class="coach-recommendations">${items.slice().reverse().map(item => `<article class="coach-recommendation"><div class="between"><strong>${item.author === 'me' ? 'Тренер' : 'Рекомендация тренера'}</strong><small>${esc(formatDate(item.createdAt))}</small></div><p>${esc(item.text)}</p>${item.status === 'acknowledged' ? '<span class="coach-status">Отмечено клиентом</span>' : item.author === 'peer' && link.role === 'client' ? `<button class="coach-action secondary" type="button" data-coach-action="ack-recommendation" data-id="${esc(item.id)}" data-link-id="${esc(link.id)}">Понятно, учту</button>` : '<span class="coach-status">Ожидает ответа</span>'}</article>`).join('')}</div>`;
  }
  function renderNutritionGoals(link) {
    const proposals = link.nutritionGoalProposals || [];
    const proposalRows = proposals.length ? `<div class="coach-recommendations">${proposals.slice().reverse().map(item => `<article class="coach-recommendation"><div class="between"><strong>${item.status === 'pending' ? 'Предложение КБЖУ' : `КБЖУ · ${item.status === 'accepted' ? 'принято' : item.status === 'declined' ? 'отклонено' : item.status === 'cancelled' ? 'отменено' : 'закрыто'}`}</strong><small>${esc(formatDate(item.createdAt))}</small></div><p>${esc(String(item.goals?.kcal))} ккал · Б ${esc(String(item.goals?.protein))} г · Ж ${esc(String(item.goals?.fat))} г · У ${esc(String(item.goals?.carbs))} г</p>${item.note ? `<p>${esc(item.note)}</p>` : ''}${item.status === 'pending' && link.role === 'client' ? `<div class="coach-inline"><button class="coach-action" type="button" data-coach-action="accept-goals" data-id="${esc(item.id)}" data-link-id="${esc(link.id)}">Принять цели</button><button class="coach-action secondary" type="button" data-coach-action="decline-goals" data-id="${esc(item.id)}" data-link-id="${esc(link.id)}">Отклонить</button></div>` : ''}</article>`).join('')}</div>` : '<div class="coach-empty">Предложений пока нет.</div>';
    const goals = link.nutritionGoals;
    const current = goals ? `<div class="coach-summary-item"><strong>Текущие дневные ориентиры клиента</strong><br>${esc(String(goals.kcal || '—'))} ккал · Б ${esc(String(goals.protein || '—'))} г · Ж ${esc(String(goals.fat || '—'))} г · У ${esc(String(goals.carbs || '—'))} г</div>` : '';
    const form = link.role === 'trainer' && link.permissions.nutritionGoals ? `<form class="coach-subsection" data-coach-goals-form data-link-id="${esc(link.id)}"><label class="coach-field-label">Предложить дневные цели</label><div class="coach-goals-grid"><label>Ккал<input class="coach-input" name="kcal" type="number" min="1" max="10000" required></label><label>Белки, г<input class="coach-input" name="protein" type="number" min="1" max="2000" required></label><label>Жиры, г<input class="coach-input" name="fat" type="number" min="1" max="2000" required></label><label>Углеводы, г<input class="coach-input" name="carbs" type="number" min="1" max="2000" required></label></div><label class="coach-field-label">Комментарий</label><textarea class="coach-input" name="note" rows="2" maxlength="500" placeholder="Почему предлагаешь эти ориентиры"></textarea><button class="coach-action" type="submit">Отправить на согласование</button><small class="muted">Цели применятся только после принятия клиентом. Это ориентир для тренировок, а не медицинская рекомендация; при ограничениях обсудите рацион со специалистом.</small></form>` : '';
    return `${current}<div class="coach-subsection"><div class="eyebrow">ПРЕДЛОЖЕНИЯ И ИСТОРИЯ</div>${proposalRows}</div>${form}`;
  }
  function renderTrainerPanel(link, tab) {
    const tabs = ['overview', ...(link.permissions.progress ? ['progress'] : []), 'workouts', 'nutrition', 'feedback'];
    const labels = { overview: 'Обзор', progress: 'Замеры', workouts: 'Тренировки', nutrition: 'Питание', feedback: 'Рекомендации' };
    const nav = `<div class="coach-client-tabs" role="tablist" aria-label="Разделы клиента">${tabs.map(key => `<button type="button" role="tab" aria-selected="${tab === key}" class="${tab === key ? 'active' : ''}" data-coach-tab="${key}" data-link-id="${esc(link.id)}">${labels[key]}</button>`).join('')}</div>`;
    let body = '';
    if (tab === 'overview') {
      const tiles = [];
      if (link.permissions.workouts) tiles.push(`<div class="coach-summary-item"><strong>${esc(String(link.workouts?.count || 0))}</strong><br>завершённых тренировок</div>`);
      if (link.permissions.progress) { const latestWeight = link.progress?.measurements?.find(item => item.values?.weight)?.values?.weight ?? link.progress?.weight; tiles.push(`<div class="coach-summary-item">Текущий вес<br><strong>${esc(String(latestWeight || 'не указан'))}${latestWeight ? ' кг' : ''}</strong></div>`); }
      if (link.permissions.nutrition) tiles.push(`<div class="coach-summary-item"><strong>${esc(String((link.nutrition || []).length))}</strong><br>дней с данными о питании</div>`);
      body = tiles.length ? `<div class="coach-summary">${tiles.join('')}</div><div class="coach-subsection"><div class="eyebrow">ПОСЛЕДНЯЯ АКТИВНОСТЬ</div>${renderAssignments(link)}${renderWorkoutSummary(link.permissions.workouts ? link.workouts : null)}</div>` : '<div class="coach-empty">Клиент ещё не разрешил доступ к сводкам. Связь и переписка остаются доступны.</div>';
    } else if (tab === 'workouts') {
      const sessions = link.workouts?.recent || [];
      const exerciseOptions = exerciseList.map(item => '<label class="coach-exercise-option" data-exercise-name="' + esc(item.name.toLocaleLowerCase('ru')) + '"><input type="checkbox" name="exerciseIds" value="' + esc(item.id) + '"><span>' + esc(item.name) + '</span></label>').join('');
      const form = link.permissions.workouts ? `<form class="coach-subsection" data-coach-workout-form data-link-id="${esc(link.id)}"><label class="coach-field-label">Назначить тренировку на дату</label><input class="coach-input" name="title" maxlength="80" placeholder="Например, Силовая · верх тела" required><input class="coach-input coach-date-input" name="date" type="date" min="${new Date().toISOString().slice(0, 10)}" value="${new Date().toISOString().slice(0, 10)}" required><label class="coach-field-label">Упражнения из каталога · выбери одно или несколько</label><input class="coach-input coach-exercise-search" type="search" data-coach-exercise-search placeholder="Найти упражнение"><div class="coach-exercise-options" role="group" aria-label="Упражнения для тренировки">${exerciseOptions}</div><small class="coach-exercise-count" data-coach-exercise-count aria-live="polite">Выбрано: 0</small><div class="coach-goals-grid"><label>Подходы<input class="coach-input" name="sets" type="number" min="1" max="20" value="3" required></label><label>Повторы<input class="coach-input" name="reps" maxlength="20" value="8–12" required></label><label>Отдых<input class="coach-input" name="rest" maxlength="20" value="90 сек" required></label></div><label class="coach-field-label">Комментарий к плану</label><textarea class="coach-input" name="note" rows="2" maxlength="500" placeholder="Техника, интенсивность, ограничения"></textarea><button class="coach-action" type="submit">Предложить подопечному</button><small class="muted">После принятия тренировка появится в его программах. Выполнение и записи остаются за клиентом.</small></form>` : '';
      body = `${link.permissions.workouts ? `<div class="coach-subsection"><div class="eyebrow">ПОСЛЕДНИЕ ЗАВЕРШЁННЫЕ ЗАНЯТИЯ</div>${sessions.length ? sessions.map(item => `<div class="coach-assignment coach-session-row"><span><strong>${esc(item.planName || 'Тренировка')}</strong><small>${esc(formatDate(item.date))} · ${esc(formatDuration(item.durationSeconds))} · ${esc(String(item.exercises))} упражн.</small>${item.exerciseNames?.length ? `<small>${item.exerciseNames.map(esc).join(' · ')}</small>` : ''}</span></div>`).join('') : '<div class="coach-empty">Завершённых тренировок пока нет.</div>'}</div>${renderAssignments(link)}${renderWorkoutAssignments(link)}${form}` : '<div class="coach-empty">Клиент не разрешил просмотр и назначение тренировок.</div>'}`;
    } else if (tab === 'progress') {
      const measurements = link.permissions.progress ? link.progress?.measurements || [] : [];
      const measureLabels = { weight: ['Вес', 'кг'], chest: ['Грудь', 'см'], waist: ['Талия', 'см'], hips: ['Бёдра', 'см'], arm: ['Плечо / бицепс', 'см'], forearm: ['Предплечье', 'см'], thigh: ['Бедро', 'см'], calf: ['Голень', 'см'] };
      body = `<div class="coach-subsection"><div class="eyebrow">ЗАМЕРЫ ТЕЛА</div>${measurements.length ? measurements.map(item => `<div class="coach-assignment"><span><strong>${esc(formatDate(item.date))}</strong><small>${Object.entries(measureLabels).filter(([key]) => Number.isFinite(Number(item.values?.[key]))).map(([key, [label, unit]]) => `${esc(label)}: ${esc(String(item.values[key]))} ${unit}`).join(' · ') || 'Значения не указаны'}</small></span></div>`).join('') : '<div class="coach-empty">Клиент пока не добавил замеры тела.</div>'}</div>`;
    } else if (tab === 'nutrition') {
      const days = link.nutrition || [];
      body = `<div class="coach-subsection"><div class="eyebrow">СВОДКА ПО ДНЯМ</div>${link.permissions.nutrition ? days.length ? days.map(day => `<div class="coach-assignment"><span><strong>${esc(formatDate(day.date))}</strong><small>${esc(String(day.entries))} записей</small></span><span>${esc(day.kcal==null?'—':String(day.kcal))} ккал<br><small>Б ${esc(day.protein==null?'—':String(day.protein))} · Ж ${esc(day.fat==null?'—':String(day.fat))} · У ${esc(day.carbs==null?'—':String(day.carbs))} г</small></span></div>`).join('') : '<div class="coach-empty">За последние дни записей нет.</div>' : '<div class="coach-empty">Клиент не разрешил просмотр сводки питания.</div>'}</div>${link.permissions.nutritionGoals ? renderNutritionGoals(link) : '<div class="coach-empty">Доступ к предложениям КБЖУ не разрешён.</div>'}`;
    } else {
      const recommendationForm = link.role === 'trainer' && (link.permissions.workouts || link.permissions.nutrition) ? `<form class="coach-subsection" data-coach-recommendation-form data-link-id="${esc(link.id)}"><label class="coach-field-label">Новая рекомендация</label><textarea class="coach-input" name="text" rows="3" minlength="3" maxlength="1000" placeholder="Напиши, на что обратить внимание в тренировках или питании" required></textarea><button class="coach-action" type="submit">Отправить рекомендацию</button></form>` : '';
      body = `${recommendationForm}<div class="coach-subsection"><div class="eyebrow">РЕКОМЕНДАЦИИ</div>${renderRecommendationList(link)}</div>${renderMessages(link)}`;
    }
    return `${nav}<div class="coach-client-panel" role="tabpanel">${body}</div>`;
  }
  function renderClientPermissions(link) {
    if (link.role !== 'client') return '';
    return `<form class="coach-subsection" data-coach-permissions-form data-link-id="${esc(link.id)}"><div class="eyebrow">МОИ РАЗРЕШЕНИЯ</div><div class="coach-checks">${Object.entries(scopeLabels).map(([key, label]) => `<label class="coach-check"><input type="checkbox" data-coach-scope="${key}"${link.permissions?.[key] ? ' checked' : ''}>${esc(label)}</label>`).join('')}</div><button class="coach-action secondary" type="submit">Сохранить доступ</button></form>`;
  }
  function renderRelationship(link, login) {
    link._myLogin = login;
    const roleLabel = link.role === 'trainer' ? 'Твой клиент' : 'Твой тренер';
    const tab = clientTabs.get(link.id) || 'overview';
    return `<article class="coach-relationship"><div class="coach-person"><div><small>${roleLabel}</small><strong>${esc(link.peer.name || link.peer.login)}</strong><small>@${esc(link.peer.login)} · с ${esc(formatDate(link.createdAt))}</small></div><button class="coach-action secondary" type="button" data-coach-action="revoke-link" data-id="${esc(link.id)}">Отключить</button></div><div class="coach-permission-pills">${permissionPills(link.permissions)}</div>${link.role === 'trainer' ? renderTrainerPanel(link, tab) : `${renderClientPermissions(link)}${renderAssignments(link)}${renderWorkoutAssignments(link)}<div class="coach-subsection"><div class="eyebrow">РЕКОМЕНДАЦИИ ТРЕНЕРА</div>${renderRecommendationList(link)}${renderNutritionGoals(link)}</div>${renderMessages(link)}`}</article>`;
  }
  function clientWeight(link) {
    if (!link.permissions?.progress) return null;
    return link.progress?.measurements?.find(item => item.values?.weight != null)?.values?.weight ?? link.progress?.weight ?? null;
  }
  function renderTrainerClientCard(link) {
    const name = link.peer.name || link.peer.login;
    const latest = link.permissions.workouts ? link.workouts?.recent?.[0] : null;
    const subtitle = latest
      ? `Тренировок: ${Number(link.workouts?.count || 0)} · последнее занятие ${formatDate(latest.date)}`
      : link.permissions.nutrition && link.nutrition?.length
        ? `Питание ведётся · ${link.nutrition.length} дн.`
        : `Связь с ${formatDate(link.createdAt)}`;
    const weight = clientWeight(link);
    const selected = link.id === selectedTrainerClientLinkId;
    return `<button class="coach-client-card${selected ? ' selected' : ''}" type="button" data-coach-select-client="${esc(link.id)}"><span class="coach-client-avatar" aria-hidden="true">${esc(String(name).trim().slice(0, 1).toLocaleUpperCase('ru') || 'К')}</span><span class="coach-client-card-copy"><strong>${esc(name)}</strong><small>@${esc(link.peer.login)} · ${esc(subtitle)}</small>${link.trainerNote ? `<span class="coach-client-private-note">Заметка: ${esc(link.trainerNote)}</span>` : ''}<span class="coach-client-chips">${weight != null && weight !== '' ? `<em>${esc(String(weight))} кг</em>` : ''}${link.permissions.workouts ? `<em>${esc(String(link.workouts?.count || 0))} тренировок</em>` : ''}</span></span><span class="coach-client-chevron" aria-hidden="true">›</span></button>`;
  }
  function renderTrainerClientDetail(link) {
    link._myLogin = latestLogin;
    const name = link.peer.name || link.peer.login;
    const weight = clientWeight(link);
    const tab = clientTabs.get(link.id) || 'overview';
    const quickTabs = [
      ...(link.permissions.workouts ? [['workouts', 'Назначить тренировку', 'Ⅱ']] : []),
      ...(link.permissions.nutritionGoals ? [['nutrition', 'Предложить КБЖУ', '◉']] : []),
      ...(link.permissions.workouts || link.permissions.nutrition ? [['feedback', 'Сообщение', '…']] : []),
      ...(link.permissions.progress ? [['progress', 'Посмотреть замеры', '⌁']] : [])
    ];
    const tiles = [
      ...(weight != null && weight !== '' ? [`<div class="coach-client-stat"><strong>${esc(String(weight))} кг</strong><small>Текущий вес</small></div>`] : []),
      ...(link.permissions.workouts ? [`<div class="coach-client-stat"><strong>${esc(String(link.workouts?.count || 0))}</strong><small>Тренировок</small></div>`] : []),
      ...(link.permissions.nutrition ? [`<div class="coach-client-stat"><strong>${esc(String(link.nutrition?.length || 0))}</strong><small>Дней питания</small></div>`] : []),
      `<div class="coach-client-stat"><strong>${esc(formatDate(link.createdAt))}</strong><small>Вместе с</small></div>`
    ].join('');
    const note = `<form class="coach-private-note" data-coach-note-form data-link-id="${esc(link.id)}"><label for="coachTrainerNote-${esc(link.id)}"><strong>Заметка для себя</strong><small>Видна только тебе</small></label><textarea id="coachTrainerNote-${esc(link.id)}" class="coach-input" name="note" rows="2" maxlength="500" placeholder="Например, цель на месяц или важные наблюдения">${esc(link.trainerNote || '')}</textarea><button class="coach-action secondary" type="submit">Сохранить заметку</button></form>`;
    return `<article class="coach-client-detail"><header class="coach-client-detail-header"><button type="button" class="coach-detail-back" data-coach-action="back-clients" aria-label="Назад к подопечным">‹</button><span class="coach-client-avatar large" aria-hidden="true">${esc(String(name).trim().slice(0, 1).toLocaleUpperCase('ru') || 'К')}</span><span class="coach-client-detail-name"><strong>${esc(name)}</strong><small>@${esc(link.peer.login)} · с ${esc(formatDate(link.createdAt))}</small></span><button class="coach-action secondary compact" type="button" data-coach-action="revoke-link" data-id="${esc(link.id)}">Отключить</button></header><div class="coach-client-stats">${tiles}</div><div class="coach-permission-pills">${permissionPills(link.permissions)}</div>${note}<div class="coach-quick-actions"><strong>Быстрые действия</strong><div>${quickTabs.map(([key, label, icon]) => `<button class="coach-quick-action" type="button" data-coach-quicktab="${key}" data-link-id="${esc(link.id)}"><span aria-hidden="true">${icon}</span>${label}</button>`).join('')}</div></div>${renderTrainerPanel(link, tab)}</article>`;
  }
  function renderTrainerHome(relationships) {
    const clients = relationships.filter(link => link.role === 'trainer');
    if (!clients.some(link => link.id === selectedTrainerClientLinkId)) selectedTrainerClientLinkId = '';
    trainerClientCount.textContent = String(clients.length);
    if (selectedTrainerClientLinkId) {
      const link = clients.find(item => item.id === selectedTrainerClientLinkId);
      trainerHome.classList.add('hidden');
      trainerClientDetail.classList.remove('hidden');
      trainerClientDetail.innerHTML = renderTrainerClientDetail(link);
      return;
    }
    trainerClientDetail.classList.add('hidden');
    trainerHome.classList.remove('hidden');
    const query = trainerClientSearch.value.trim().toLocaleLowerCase('ru');
    const filtered = clients.filter(link => !query || `${link.peer.name || ''} ${link.peer.login || ''} ${link.trainerNote || ''}`.toLocaleLowerCase('ru').includes(query));
    trainerClientList.innerHTML = filtered.length ? filtered.map(renderTrainerClientCard).join('') : clients.length ? '<div class="coach-empty">По этому запросу подопечные не найдены.</div>' : '<div class="coach-empty">Пока нет подключённых подопечных. Создай код приглашения — клиент сам примет его и выберет доступ к данным.</div>';
  }
  function renderOverview(data, login) {
    setTrainerModeUI(data.trainerMode === true);
    renderInvitations(data.invitations || []);
    const relationships = data.relationships || [];
    if (data.trainerMode === true) {
      renderTrainerHome(relationships);
      return;
    }
    const clientLinks = relationships.filter(link => link.role === 'client');
    relationshipRoot.innerHTML = clientLinks.length ? clientLinks.map(link => renderRelationship(link, login)).join('') : '<div class="coach-empty">Пока нет подключённых тренеров. Введи код приглашения, чтобы создать связь.</div>';
    relationshipCount.textContent = String(clientLinks.length);
    relationshipHint.textContent = clientLinks.length ? `${clientLinks.length} подключено · доступ можно отозвать в любой момент` : 'Подключённые тренеры и подопечные';
    if (clientLinkCountBeforeLoad === null || (clientLinkCountBeforeLoad === 0 && clientLinks.length > 0)) relationshipsDisclosure.open = clientLinks.length > 0;
    if (clientLinks.length) clientSections.insertBefore(relationshipsDisclosure, connectSection);
    else clientSections.insertBefore(connectSection, relationshipsDisclosure);
    clientLinkCountBeforeLoad = clientLinks.length;
  }
  function renderApplication(application) {
    if (!applicationForm || !applicationStatus) return;
    applicationForm.classList.remove('hidden');
    applicationStatus.classList.add('hidden');
    applicationStatus.innerHTML = '';
    if (!application) return;
    applicationDisclosure.open = true;
    if (application.status === 'pending') {
      applicationForm.classList.add('hidden');
      applicationStatus.innerHTML = `<strong>Заявка на рассмотрении</strong><div>Отправлена ${esc(formatDate(application.createdAt))}. Решение появится здесь.</div><button type="button" class="coach-action secondary" data-coach-action="withdraw-application">Отозвать заявку</button>`;
      applicationStatus.classList.remove('hidden');
      return;
    }
    if (application.status === 'approved') {
      applicationForm.classList.add('hidden');
      applicationStatus.innerHTML = '<strong>Заявка одобрена</strong><div>Режим тренера включён. Перезагрузи страницу, если кабинет ещё не появился.</div>';
      applicationStatus.classList.remove('hidden');
      return;
    }
    if (application.status === 'rejected') {
      applicationStatus.innerHTML = `<strong>Заявка отклонена</strong><div>${esc(application.decisionNote || 'Администратор не добавил пояснение.')}</div><div>Можно исправить заявку и отправить её повторно.</div>`;
      applicationStatus.classList.remove('hidden');
      applicationForm.elements.fullName.value = application.fullName || '';
      applicationForm.elements.experienceYears.value = String(application.experienceYears ?? 0);
      applicationForm.elements.about.value = application.about || '';
      applicationForm.elements.specialization.value = application.specialization || '';
      applicationForm.elements.education.value = application.education || '';
      return;
    }
    if (application.status === 'withdrawn') {
      applicationStatus.innerHTML = '<strong>Заявка отозвана</strong><div>При необходимости заполни форму и отправь её снова.</div>';
      applicationStatus.classList.remove('hidden');
    }
  }
  async function load() {
    setFeedback('Загружаю связи и разрешённую сводку…');
    try {
      const [data, session, applicationData] = await Promise.all([
        request('/api/coach/overview'), request('/api/session'), request('/api/coach/applications')
      ]);
      latestOverview = data;
      latestLogin = session.user.login;
      renderOverview(data, session.user.login);
      renderApplication(applicationData.application);
      setFeedback('');
    } catch (error) {
      setFeedback(error.message, true);
    }
  }
  async function createInvite() {
    setFeedback('Создаю одноразовый код…');
    try {
      const result = await request('/api/coach/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      inviteToken = result.invitation.token;
      inviteResult.innerHTML = `<div class="eyebrow">ПЕРЕДАЙ КЛИЕНТУ</div><div class="coach-code">${esc(inviteToken)}</div><button type="button" class="coach-action secondary" data-coach-action="copy-invite">Скопировать код</button><div class="coach-code-hint">Код одноразовый и действует до ${esc(formatDate(result.invitation.expiresAt))}. Сохрани его сейчас: сервер хранит только хеш и не сможет показать код повторно.</div>`;
      inviteResult.classList.remove('hidden');
      setFeedback('Код создан. Передай его клиенту по выбранному вами каналу связи.');
      await load();
    } catch (error) { setFeedback(error.message, true); }
  }
  async function submitApplication(form) {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    setFeedback('Отправляю заявку администратору…');
    try {
      const values = new FormData(form);
      const result = await request('/api/coach/applications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: values.get('fullName'), experienceYears: Number(values.get('experienceYears')),
          about: values.get('about'), specialization: values.get('specialization'), education: values.get('education')
        })
      });
      if (result.application?.status === 'pending') setFeedback('Заявка отправлена. Её рассмотрит администратор приложения.');
      await load();
    } catch (error) { setFeedback(error.message, true); }
    finally { button.disabled = false; }
  }
  async function updateAdminApplicationBadge() {
    const badge = document.getElementById('adminCoachApplicationBadge');
    if (!badge) return;
    try {
      const session = await request('/api/session');
      if (!session.user?.isAdmin) {
        badge.classList.add('hidden');
        if (applicationBadgeTimer) { clearInterval(applicationBadgeTimer); applicationBadgeTimer = null; }
        return;
      }
      if (!applicationBadgeTimer) applicationBadgeTimer = setInterval(() => { void updateAdminApplicationBadge(); }, 60_000);
      const data = await request('/api/admin/coach-applications?count=1');
      badge.textContent = data.pendingCount > 99 ? '99+' : String(data.pendingCount || 0);
      badge.classList.toggle('hidden', !data.pendingCount);
      badge.setAttribute('aria-label', `Новых заявок на тренерство: ${data.pendingCount || 0}`);
    } catch { badge.classList.add('hidden'); }
  }
  async function loadAdminApplicationNotification() {
    const notice = document.getElementById('adminCoachApplicationsNotice');
    if (!notice) return;
    try {
      const session = await request('/api/session');
      if (!session.user?.isAdmin) {
        notice.classList.add('hidden');
        await updateAdminApplicationBadge();
        return;
      }
      const data = await request('/api/admin/coach-applications?count=1');
      const badge = document.getElementById('adminCoachApplicationBadge');
      if (badge) {
        badge.textContent = data.pendingCount > 99 ? '99+' : String(data.pendingCount || 0);
        badge.classList.toggle('hidden', !data.pendingCount);
        badge.setAttribute('aria-label', `Новых заявок на тренерство: ${data.pendingCount || 0}`);
      }
      if (!data.pendingCount) {
        notice.classList.add('hidden');
        return;
      }
      const title = data.pendingCount === 1 ? 'Новая заявка на тренерство' : `Новых заявок на тренерство: ${esc(data.pendingCount)}`;
      notice.innerHTML = `<div class="eyebrow">ТРЕБУЕТ ВНИМАНИЯ</div><h2>${title}</h2><p class="muted">Открой админ-панель, чтобы посмотреть анкеты и принять решение.</p><button type="button" class="coach-action" data-action="openAdmin">Открыть заявки</button>`;
      notice.classList.remove('hidden');
    } catch {
      notice.classList.add('hidden');
    }
  }
  async function previewInvite(event) {
    event.preventDefault();
    inviteToken = document.getElementById('coachInviteCode').value.trim();
    invitationPreview = null;
    consent.classList.add('hidden');
    setFeedback('Проверяю приглашение…');
    try {
      invitationPreview = await request('/api/coach/invitations/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inviteToken }) });
      document.getElementById('coachTrainerIdentity').innerHTML = `<div class="coach-summary-item">Приглашает тренер <strong>${esc(invitationPreview.trainer.name || '@' + invitationPreview.trainer.login)}</strong>${invitationPreview.trainer.name ? `<br><small>@${esc(invitationPreview.trainer.login)}</small>` : ''}</div>`;
      consent.classList.remove('hidden');
      setFeedback('Проверь имя тренера и отметь только те разрешения, которые хочешь выдать.');
    } catch (error) { setFeedback(error.message, true); }
  }
  async function acceptInvite() {
    if (!invitationPreview || !inviteToken) return;
    const permissions = scopePayload(consent);
    try {
      await request('/api/coach/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inviteToken, permissions }) });
      invitationPreview = null;
      inviteToken = '';
      document.getElementById('coachInviteCode').value = '';
      consent.classList.add('hidden');
      consent.querySelectorAll('[data-coach-scope]').forEach(input => { input.checked = false; });
      setFeedback('Связь подтверждена. Разрешения можно изменить в карточке тренера.');
      await load();
    } catch (error) { setFeedback(error.message, true); }
  }
  async function act(button) {
    const action = button.dataset.coachAction;
    const id = button.dataset.id;
    if (action === 'back-clients') {
      selectedTrainerClientLinkId = '';
      if (latestOverview) renderTrainerHome(latestOverview.relationships || []);
      return;
    }
    if (action === 'create-invite') return createInvite();
    if (action === 'accept-invite') return acceptInvite();
    if (action === 'copy-invite') {
      const code = inviteResult.querySelector('.coach-code')?.textContent || '';
      try { await navigator.clipboard.writeText(code); setFeedback('Код скопирован.'); }
      catch { setFeedback('Выдели код приглашения и скопируй его вручную.'); }
      return;
    }
    if (action === 'revoke-invite') {
      if (!window.confirm('Отменить это приглашение? Код перестанет работать.')) return;
      try { await request(`/api/coach/invitations/${id}`, { method: 'DELETE' }); setFeedback('Приглашение отменено.'); await load(); }
      catch (error) { setFeedback(error.message, true); }
      return;
    }
    if (action === 'revoke-link') {
      if (!window.confirm('Отключить эту связь? Тренер сразу потеряет доступ к разрешённым данным. История тренировок останется у владельца аккаунта.')) return;
      try { await request(`/api/coach/links/${id}`, { method: 'DELETE' }); setFeedback('Связь отключена.'); await load(); }
      catch (error) { setFeedback(error.message, true); }
      return;
    }
    if (action === 'accept-program') {
      try {
        await window.flushPendingProfileWrites?.();
        await request('/api/coach/links/' + button.dataset.linkId + '/assignments/' + id + '/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await window.reloadProfileDataFromServer?.();
        setFeedback('Программа добавлена в твои программы.');
        await load();
      } catch (error) { setFeedback(error.message, true); }
      return;
    }
    if (action === 'decline-program') {
      try { await request(`/api/coach/links/${button.dataset.linkId}/assignments/${id}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setFeedback('Предложение отклонено.'); await load(); }
      catch (error) { setFeedback(error.message, true); }
      return;
    }
    if (action === 'ack-recommendation') {
      try { await request(`/api/coach/links/${button.dataset.linkId}/recommendations/${id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setFeedback('Отметка отправлена тренеру.'); await load(); }
      catch (error) { setFeedback(error.message, true); }
      return;
    }
    if (action === 'accept-goals' || action === 'decline-goals') {
      const decision = action === 'accept-goals' ? 'accept' : 'decline';
      if (decision === 'accept' && !window.confirm('Применить предложенные цели КБЖУ в дневнике питания?')) return;
      try {
        if (decision === 'accept') await window.flushPendingProfileWrites?.();
        await request('/api/coach/links/' + button.dataset.linkId + '/nutrition-goals/' + id + '/' + decision, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (decision === 'accept') await window.reloadProfileDataFromServer?.();
        setFeedback(decision === 'accept' ? 'Цели приняты и применены в дневнике питания.' : 'Предложение КБЖУ отклонено.');
        await load();
      } catch (error) { setFeedback(error.message, true); }
      return;
    }
    if (action === 'accept-workout' || action === 'decline-workout') {
      const decision = action === 'accept-workout' ? 'accept' : 'decline';
      if (decision === 'accept' && !window.confirm('Принять тренировку? Она добавится в твои программы и календарь.')) return;
      try {
        await window.flushPendingProfileWrites?.();
        await request('/api/coach/links/' + button.dataset.linkId + '/workout-assignments/' + id + '/' + decision, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (decision === 'accept') await window.reloadProfileDataFromServer?.();
        setFeedback(decision === 'accept' ? 'Тренировка добавлена в твои программы и календарь.' : 'Тренировка отклонена.');
        await load();
      } catch (error) { setFeedback(error.message, true); }
      return;
    }
    if (action === 'withdraw-application') {
      if (!window.confirm('Отозвать заявку на тренерство?')) return;
      try { await request('/api/coach/applications', { method: 'DELETE' }); setFeedback('Заявка отозвана.'); await load(); }
      catch (error) { setFeedback(error.message, true); }
    }
  }
  async function submitForm(form, kind) {
    const linkId = form.dataset.linkId;
    try {
      if (kind === 'message') {
        const text = new FormData(form).get('text');
        await request(`/api/coach/links/${linkId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        form.reset();
        setFeedback('Сообщение отправлено.');
      } else if (kind === 'permissions') {
        await request(`/api/coach/links/${linkId}/permissions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: scopePayload(form) }) });
        setFeedback('Разрешения обновлены.');
      } else if (kind === 'program') {
        const programId = new FormData(form).get('programId');
        await request(`/api/coach/links/${linkId}/assignments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ programId }) });
        setFeedback('Предложение отправлено клиенту; он должен подтвердить добавление.');
      } else if (kind === 'recommendation') {
        const text = new FormData(form).get('text');
        await request(`/api/coach/links/${linkId}/recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        setFeedback('Рекомендация отправлена клиенту.');
      } else if (kind === 'goals') {
        const values = new FormData(form);
        const goals = Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(key => [key, Number(values.get(key))]));
        await request(`/api/coach/links/${linkId}/nutrition-goals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goals, note: values.get('note') }) });
        setFeedback('Предложение КБЖУ отправлено клиенту на согласование.');
      } else if (kind === 'checkin') {
        const values = new FormData(form);
        await request('/api/coach/links/' + linkId + '/workout-assignments/' + form.dataset.assignmentId + '/check-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effort: Number(values.get('effort')), wellbeing: values.get('wellbeing'), note: values.get('note') }) });
        setFeedback('Отзыв отправлен тренеру.');
      } else if (kind === 'checkin-reply') {
        const values = new FormData(form);
        await request('/api/coach/links/' + linkId + '/workout-assignments/' + form.dataset.assignmentId + '/check-in/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reply: values.get('reply') }) });
        setFeedback('Ответ отправлен подопечному.');
      } else if (kind === 'workout') {
        const values = new FormData(form);
        const exerciseIds = values.getAll('exerciseIds'); if(!exerciseIds.length){setFeedback('Выбери хотя бы одно упражнение.',true);return;}
        await request(`/api/coach/links/${linkId}/workout-assignments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: values.get('title'), date: values.get('date'), exerciseIds, sets: Number(values.get('sets')), reps: values.get('reps'), rest: values.get('rest'), note: values.get('note') }) });
        setFeedback('Тренировка отправлена клиенту на согласование.');
      } else if (kind === 'note') {
        const note = new FormData(form).get('note');
        await request(`/api/coach/links/${linkId}/note`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
        setFeedback('Личная заметка сохранена. Подопечный её не видит.');
      }
      await load();
    } catch (error) { setFeedback(error.message, true); }
  }
  const moreLinks = document.querySelector('#page-more .more-links');
  if (moreLinks && !document.getElementById('coachMenuItem')) {
    const button = document.createElement('button');
    button.id = 'coachMenuItem';
    button.className = 'quick-action';
    button.dataset.action = 'nav:coach';
    button.innerHTML = '<span class="quick-action-icon" aria-hidden="true">↔</span><span>Тренер и клиент</span><b>›</b>';
    moreLinks.prepend(button);
  }
  setTrainerModeUI(trainerMode);
  document.addEventListener('click', event => {
    const selectClient = event.target.closest('[data-coach-select-client]');
    if (selectClient) {
      selectedTrainerClientLinkId = selectClient.dataset.coachSelectClient;
      if (latestOverview) renderTrainerHome(latestOverview.relationships || []);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const tab = event.target.closest('[data-coach-tab]');
    if (tab) {
      clientTabs.set(tab.dataset.linkId, tab.dataset.coachTab);
      if (latestOverview) renderOverview(latestOverview, latestLogin);
      return;
    }
    const quickTab = event.target.closest('[data-coach-quicktab]');
    if (quickTab) {
      clientTabs.set(quickTab.dataset.linkId, quickTab.dataset.coachQuicktab);
      if (latestOverview) renderTrainerHome(latestOverview.relationships || []);
      return;
    }
    const button = event.target.closest('[data-coach-action]');
    if (button) { event.preventDefault(); void act(button); return; }
    const nav = event.target.closest('[data-action="nav:coach"]');
    if (nav) {
      document.querySelectorAll('.navbtn').forEach(item => item.classList.toggle('active', item.dataset.action === 'nav:more'));
      window.setTimeout(() => { void load(); }, 0);
    }
    if (event.target.closest('[data-action="notifications"]')) window.setTimeout(() => { void loadAdminApplicationNotification(); }, 0);
  });
  window.addEventListener('ritm:account-ready', event => {
    if (event.detail?.isAdmin) void updateAdminApplicationBadge();
    else {
      document.getElementById('adminCoachApplicationBadge')?.classList.add('hidden');
      if (applicationBadgeTimer) { clearInterval(applicationBadgeTimer); applicationBadgeTimer = null; }
    }
  });
  window.addEventListener('focus', () => { void updateAdminApplicationBadge(); });
  void updateAdminApplicationBadge();
  document.addEventListener('change', event => {
    if (!event.target.matches('[data-coach-workout-form] input[name="exerciseIds"]')) return;
    const form = event.target.form;
    const selected = form.querySelectorAll('input[name="exerciseIds"]:checked').length;
    const count = form.querySelector('[data-coach-exercise-count]');
    if (count) count.textContent = 'Выбрано: ' + selected;
    form.querySelectorAll('.coach-exercise-option').forEach(option => option.classList.toggle('is-selected', option.querySelector('input')?.checked === true));
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form.id === 'coachPreviewForm') { void previewInvite(event); return; }
    if (form.id === 'coachApplicationForm') { event.preventDefault(); void submitApplication(form); return; }
    const kind = form.matches('[data-coach-message-form]') ? 'message' : form.matches('[data-coach-permissions-form]') ? 'permissions' : form.matches('[data-coach-program-form]') ? 'program' : form.matches('[data-coach-recommendation-form]') ? 'recommendation' : form.matches('[data-coach-goals-form]') ? 'goals' : form.matches('[data-coach-checkin-form]') ? 'checkin' : form.matches('[data-coach-checkin-reply-form]') ? 'checkin-reply' : form.matches('[data-coach-workout-form]') ? 'workout' : form.matches('[data-coach-note-form]') ? 'note' : '';
    if (!kind) return;
    event.preventDefault();
    void submitForm(form, kind);
  });
  document.addEventListener('input', event => {
    if (event.target === trainerClientSearch) {
      if (latestOverview && !selectedTrainerClientLinkId) renderTrainerHome(latestOverview.relationships || []);
      return;
    }
    if (event.target.id === 'coachInviteCode') {
      invitationPreview = null;
      consent.classList.add('hidden');
    }
    if (event.target.matches('[data-coach-exercise-search]')) {
      const term = event.target.value.trim().toLocaleLowerCase('ru');
      const form = event.target.closest('[data-coach-workout-form]');
      form?.querySelectorAll('.coach-exercise-option').forEach(option => { option.hidden = !option.dataset.exerciseName.includes(term); });
    }
  });
})();
