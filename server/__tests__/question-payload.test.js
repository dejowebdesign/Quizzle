const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..', '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quizzle-payload-'));

fs.cpSync(path.join(projectRoot, 'content'), path.join(workspace, 'content'), {recursive: true});
process.chdir(workspace);

const express = require('express');
const socketIo = require('socket.io');
const {io: ioClient} = require(path.join(projectRoot, 'webui', 'node_modules', 'socket.io-client'));
const {firstStart} = require('../utils/file');
const {buildQuestionPayload} = require('../utils/room');
const {stripAnswerCorrectness, resolveQuestionType, shuffleSequenceAnswers} = require('../utils/quiz');

// session.js starts a module-level cleanup interval that is not unref'd, so loading the
// socket handler would otherwise keep the test process alive after all tests finish.
const trackedIntervals = [];
const originalSetInterval = global.setInterval;
global.setInterval = (fn, delay, ...args) => {
    const handle = originalSetInterval(fn, delay, ...args);
    if (typeof fn === 'function' && fn.name === 'cleanupExpiredSessions') trackedIntervals.push(handle);
    return handle;
};

const socketHandler = require('../socket');

global.setInterval = originalSetInterval;

firstStart();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {path: '/api/ws'});
io.on('connection', (socket) => socketHandler(io, socket));

let basePort;
test.before(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    basePort = server.address().port;
});

test.after(() => {
    io.disconnectSockets(true);
    io.close();
    server.closeAllConnections?.();
    server.close();
    trackedIntervals.forEach(clearInterval);
    fs.rmSync(workspace, {recursive: true, force: true});
});

const connect = () => new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${basePort}`, {
        path: '/api/ws',
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
});

const emit = (socket, event, data) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 5000);
    socket.emit(event, data, (response) => {
        clearTimeout(timer);
        resolve(response);
    });
});

const waitFor = (socket, event, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} not received`)), timeoutMs);
    socket.once(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
    });
});

const choiceQuiz = (answers) => ({
    title: 'Hauptstadt?',
    type: 'multiple-choice',
    pointMultiplier: 'none',
    answers,
});

const twoAnswers = [
    {type: 'text', content: 'Berlin', is_correct: true},
    {type: 'text', content: 'Paris', is_correct: false},
];

// Sets up a room with one host and one player, then shows the given question.
const showQuestion = async (question) => {
    const host = await connect();
    const player = await connect();

    const roomCode = await new Promise(resolve => host.emit('CREATE_ROOM', {settings: {}}, resolve));
    const joined = await emit(player, 'JOIN_ROOM', {code: roomCode, name: 'Player', character: 'wizard'});
    assert.strictEqual(joined.success, true, JSON.stringify(joined));

    const received = waitFor(player, 'QUESTION_RECEIVED');
    const shown = await emit(host, 'SHOW_QUESTION', question);
    assert.strictEqual(shown.success, true, JSON.stringify(shown));

    return {host, player, roomCode, payload: await received};
};

test('buildQuestionPayload sendet Antworttexte statt nur der Anzahl', () => {
    const payload = buildQuestionPayload(choiceQuiz(twoAnswers), {questionHistory: []});

    assert.ok(Array.isArray(payload.answers), 'answers muss ein Array sein');
    assert.deepStrictEqual(payload.answers, [
        {content: 'Berlin', type: 'text'},
        {content: 'Paris', type: 'text'},
    ]);
});

test('buildQuestionPayload entfernt is_correct und weitere Korrektheitsdaten', () => {
    const answers = [
        {type: 'text', content: 'Richtig', is_correct: true},
        {type: 'text', content: 'Falsch', is_correct: false},
    ];
    const payload = buildQuestionPayload(choiceQuiz(answers), {questionHistory: []});

    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes('is_correct'), 'is_correct darf nicht im Payload vorkommen');
    payload.answers.forEach(answer => {
        assert.deepStrictEqual(Object.keys(answer).sort(), ['content', 'type'], 'nur Anzeigeinformationen dürfen übertragen werden');
    });
});

test('Reihenfolge der Antworten bleibt erhalten, damit Index-basierte Abgabe stimmt', () => {
    const answers = [
        {type: 'text', content: 'Zuerst', is_correct: true},
        {type: 'text', content: 'Zweitens', is_correct: false},
        {type: 'text', content: 'Drittens', is_correct: false},
    ];
    const payload = buildQuestionPayload(choiceQuiz(answers), {questionHistory: []});

    assert.deepStrictEqual(payload.answers.map(a => a.content), ['Zuerst', 'Zweitens', 'Drittens']);
});

test('Fragetyp single/multiple wird aus den Antworten abgeleitet, ohne Lösegaben', () => {
    const single = buildQuestionPayload(choiceQuiz([
        {type: 'text', content: 'A', is_correct: true},
        {type: 'text', content: 'B', is_correct: false},
    ]), {questionHistory: []});
    const multiple = buildQuestionPayload(choiceQuiz([
        {type: 'text', content: 'A', is_correct: true},
        {type: 'text', content: 'B', is_correct: true},
    ]), {questionHistory: []});

    assert.strictEqual(single.type, 'single');
    assert.strictEqual(multiple.type, 'multiple');
});

test('Teilnehmer erhält Antworttexte, aber is_correct nicht über QUESTION_RECEIVED', async () => {
    const answers = [
        {type: 'text', content: 'Besitz einer Waffe', is_correct: false},
        {type: 'text', content: 'Führen einer Waffe', is_correct: true},
        {type: 'text', content: 'Kauf einer Waffe', is_correct: false},
        {type: 'text', content: 'Verkauf einer Waffe', is_correct: false},
    ];

    const {host, player, payload} = await showQuestion(choiceQuiz(answers));

    try {
        assert.strictEqual(payload.title, 'Hauptstadt?');
        assert.deepStrictEqual(payload.answers.map(a => a.content), answers.map(a => a.content));
        assert.ok(!JSON.stringify(payload).includes('is_correct'), 'is_correct darf den Client nie erreichen');
    } finally {
        player.close();
        host.close();
    }
});

test('Lange Antworttexte werden vollständig übertragen und nicht gekürzt', async () => {
    const longAnswer = 'Eine Waffe darf nur mit entsprechender waffenrechtlicher Erlaubnis geführt werden.';
    const answers = [
        {type: 'text', content: longAnswer, is_correct: true},
        {type: 'text', content: 'Kurz', is_correct: false},
    ];

    const {host, player, payload} = await showQuestion(choiceQuiz(answers));

    try {
        assert.strictEqual(payload.answers[0].content, longAnswer, 'langer Text darf nicht abgeschnitten werden');
    } finally {
        player.close();
        host.close();
    }
});

test('Bildantworten behalten Typ image und Inhalt für die bestehende Bilddarstellung', async () => {
    const answers = [
        {type: 'image', content: 'data:image/png;base64,AAA', is_correct: true},
        {type: 'text', content: 'Textantwort', is_correct: false},
    ];

    const {host, player, payload} = await showQuestion(choiceQuiz(answers));

    try {
        assert.strictEqual(payload.answers[0].type, 'image');
        assert.strictEqual(payload.answers[0].content, 'data:image/png;base64,AAA');
        assert.strictEqual(payload.answers[1].type, 'text');
        assert.strictEqual(payload.answers[1].content, 'Textantwort');
    } finally {
        player.close();
        host.close();
    }
});

test('ANSWERS_READY bleibt erhalten und überträgt keine Korrektheitsdaten', async () => {
    const {host, player, payload} = await showQuestion(choiceQuiz(twoAnswers));

    try {
        const ready = await waitFor(player, 'ANSWERS_READY');
        assert.strictEqual(ready, true);
        assert.ok(!JSON.stringify(payload).includes('is_correct'));
    } finally {
        player.close();
        host.close();
    }
});

test('Abgabe, Scoring und Ergebnis-Mechanismus funktionieren unverändert', async () => {
    const answers = [
        {type: 'text', content: 'Richtig', is_correct: true},
        {type: 'text', content: 'Falsch', is_correct: false},
    ];

    const {host, player, payload} = await showQuestion(choiceQuiz(answers));

    try {
        // Index 0 is the correct answer; the client only knows positions, never correctness.
        assert.strictEqual(payload.answers[0].content, 'Richtig');

        await waitFor(player, 'ANSWERS_READY');
        // Register before submitting: the server broadcasts the results while handling the submit,
        // so the event can fire before the acknowledgement callback resolves.
        const resultsPromise = waitFor(player, 'ANSWER_RECEIVED');
        const submitted = await emit(player, 'SUBMIT_ANSWER', {answers: [0]});
        assert.strictEqual(submitted.success, true, JSON.stringify(submitted));

        const results = await resultsPromise;
        assert.deepStrictEqual(results.answers, [true, false], 'Auswertung muss die Korrektheit serverseitig liefern');
    } finally {
        player.close();
        host.close();
    }
});

test('Reconnection liefert die Antworttexte erneut, ohne Korrektheitsdaten', () => {
    const answers = [
        {type: 'text', content: 'Antwort mit einem sehr langen Text für die Wiederverbindung', is_correct: true},
        {type: 'text', content: 'Kurz', is_correct: false},
    ];

    // After SHOW_QUESTION the room stores stripped answers (a count) but keeps the full
    // answers in questionHistory; reconnect payloads must still carry the readable texts.
    const room = {
        questionHistory: [{answers}],
        currentQuestion: {type: 'single', answers: answers.length},
    };

    const payload = buildQuestionPayload(room.currentQuestion, room);
    assert.deepStrictEqual(payload.answers, [
        {content: answers[0].content, type: 'text'},
        {content: 'Kurz', type: 'text'},
    ]);
    assert.ok(!JSON.stringify(payload).includes('is_correct'), 'is_correct darf auch beim Reconnect fehlen');
});

test('Payload faellt ohne History auf den uebergebenen Zustand zurueck und leakt nichts', () => {
    // No usable answer source: the server must not invent data or expose correctness.
    const room = {questionHistory: []};
    const payload = buildQuestionPayload({type: 'single', answers: 2}, room);

    assert.strictEqual(payload.answers, 2, 'ohne Textquelle bleibt der uebergebene Zustand erhalten');
    assert.ok(!JSON.stringify(payload).includes('is_correct'));
});

test('Text-, Slider- und Sequence-Fragen bleiben unverändert', () => {
    const textPayload = buildQuestionPayload({type: 'text', title: 'T', answers: [{content: 'x'}]}, {questionHistory: []});
    assert.strictEqual(textPayload.maxLength, 200);
    assert.strictEqual(textPayload.answers, undefined);

    const sliderPayload = buildQuestionPayload(
        {type: 'slider', title: 'S', answers: [{min: 0, max: 100, step: 5, correctValue: 50}]},
        {questionHistory: []},
    );
    assert.deepStrictEqual(sliderPayload.sliderConfig, {min: 0, max: 100, step: 5});
    assert.strictEqual(sliderPayload.answers, undefined);

    const shuffled = shuffleSequenceAnswers([{content: 'a'}, {content: 'b'}]);
    const sequencePayload = buildQuestionPayload(
        {type: 'sequence', title: 'Q', answers: shuffled},
        {questionHistory: [{answers: shuffled, shuffledAnswers: shuffled}]},
    );
    assert.deepStrictEqual(sequencePayload.answers, shuffled);
});

test('stripAnswerCorrectness verändert die Eingabe nicht', () => {
    const answers = [{type: 'text', content: 'A', is_correct: true}];
    const stripped = stripAnswerCorrectness(answers);

    assert.deepStrictEqual(answers, [{type: 'text', content: 'A', is_correct: true}], 'Original darf nicht mutiert werden');
    assert.strictEqual(stripped[0].is_correct, undefined);
    assert.strictEqual(resolveQuestionType('multiple-choice', answers), 'single');
});
