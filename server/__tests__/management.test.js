const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..', '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quizzle-test-'));

fs.cpSync(path.join(projectRoot, 'content'), path.join(workspace, 'content'), {recursive: true});
process.chdir(workspace);

const express = require('express');
const {firstStart} = require('../utils/file');
const {createUser} = require('../utils/auth');
const {compressQuiz, decompressQuiz} = require('../utils/quiz');

firstStart();

const app = express();
app.use(express.json({limit: '100mb'}));
app.use('/api/auth', require('../routes/auth'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/admin', require('../routes/adminManagement'));
app.use('/api/quizzes', require('../routes/quizzes'));
app.use('/api/practice', require('../routes/practice'));

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
    server.close();
    fs.rmSync(workspace, {recursive: true, force: true});
});

const dataDir = path.join(workspace, 'data');

const request = async (method, url, {body, cookie} = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;

    const response = await fetch(baseUrl + url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }

    return {status: response.status, body: parsed, text, setCookie: response.headers.get('set-cookie')};
};

const loginAs = async (username, password) => {
    const result = await request('POST', '/api/auth/login', {body: {username, password}});
    assert.strictEqual(result.status, 200);
    return result.setCookie.split(';')[0];
};

const sampleQuiz = (title = 'Test Quiz') => ({
    title,
    settings: {},
    questions: [
        {
            title: 'Was ist 2+2?',
            type: 'multiple-choice',
            answers: [
                {type: 'text', content: '4', is_correct: true},
                {type: 'text', content: '5', is_correct: false},
            ],
        },
    ],
});

const writePracticeFixture = (code, {meta, quiz = sampleQuiz('Fixture'), results = []}) => {
    const dir = path.join(dataDir, 'practice-quizzes', code);
    fs.mkdirSync(path.join(dir, 'results'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'quiz.quizzle'), compressQuiz({__type: 'QUIZZLE2', ...quiz}));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    results.forEach((result, index) => {
        fs.writeFileSync(path.join(dir, 'results', `attempt-${index}.json`), JSON.stringify(result, null, 2));
    });

    return dir;
};

const sampleResult = (name) => ({
    name,
    character: 'wizard',
    answers: [{result: 'correct', userAnswer: 1, correctAnswer: [0], score: 1}],
    score: 1,
    total: 1,
    timestamp: new Date().toISOString(),
});

createUser('root', 'supersecret', 'admin');
createUser('teacher', 'supersecret', 'teacher');

let adminCookie;
let teacherCookie;

test.before(async () => {
    adminCookie = await loginAs('root', 'supersecret');
    teacherCookie = await loginAs('teacher', 'supersecret');
});

const daysFromNow = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const sameInstant = (actual, expected, message) => {
    assert.strictEqual(new Date(actual).getTime(), new Date(expected).getTime(), message);
};

const createPractice = async (body = {}) => {
    const result = await request('PUT', '/api/practice', {
        cookie: adminCookie,
        body: {...sampleQuiz('Practice Quiz'), ...body},
    });
    assert.strictEqual(result.status, 200, result.text);
    return result.body;
};

test('normale Quizze werden mit Titel, ID und Fragenanzahl aufgelistet', async () => {
    const upload = await request('PUT', '/api/quizzes', {cookie: adminCookie, body: sampleQuiz('Zonen Quiz')});
    assert.strictEqual(upload.status, 200, upload.text);

    const list = await request('GET', '/api/admin/quizzes', {cookie: adminCookie});
    assert.strictEqual(list.status, 200, list.text);

    const entry = list.body.quizzes.find(quiz => quiz.quizId === upload.body.quizId);
    assert.ok(entry, 'hochgeladenes Quiz muss in der Liste erscheinen');
    assert.strictEqual(entry.title, 'Zonen Quiz');
    assert.strictEqual(entry.questionCount, 1);
    assert.ok(!Number.isNaN(new Date(entry.created).getTime()));
});

test('Quiz-ID-Loading bleibt unverändert kompatibel', async () => {
    const upload = await request('PUT', '/api/quizzes', {cookie: adminCookie, body: sampleQuiz('Legacy Quiz')});
    const raw = await fetch(`${baseUrl}/api/quizzes/${upload.body.quizId}`);
    assert.strictEqual(raw.status, 200);

    const quiz = decompressQuiz(Buffer.from(await raw.arrayBuffer()));
    assert.strictEqual(quiz.title, 'Legacy Quiz');
    assert.strictEqual(quiz.__type, 'QUIZZLE2');
});

test('Quiz kann manuell gelöscht werden', async () => {
    const upload = await request('PUT', '/api/quizzes', {cookie: adminCookie, body: sampleQuiz('Zu löschen')});

    const deleted = await request('DELETE', `/api/admin/quizzes/${upload.body.quizId}`, {cookie: adminCookie});
    assert.strictEqual(deleted.status, 200, deleted.text);

    const reload = await fetch(`${baseUrl}/api/quizzes/${upload.body.quizId}`);
    assert.strictEqual(reload.status, 404);

    const again = await request('DELETE', `/api/admin/quizzes/${upload.body.quizId}`, {cookie: adminCookie});
    assert.strictEqual(again.status, 404);
});

test('Tests werden getrennt mit Code, Ablauf, Status und Ergebnisanzahl aufgelistet', async () => {
    const created = await createPractice({expiry: daysFromNow(7)});

    const list = await request('GET', '/api/admin/practice', {cookie: adminCookie});
    assert.strictEqual(list.status, 200, list.text);

    const entry = list.body.practiceQuizzes.find(item => item.code === created.practiceCode);
    assert.ok(entry, 'erstellter Test muss in der Liste erscheinen');
    assert.strictEqual(entry.title, 'Practice Quiz');
    assert.strictEqual(entry.expired, false);
    assert.strictEqual(entry.resultCount, 0);
    assert.ok(!Number.isNaN(new Date(entry.expiry).getTime()));
    assert.ok(!Number.isNaN(new Date(entry.created).getTime()));
});

test('Test ohne Ablaufdatum läuft dauerhaft und ist startbar', async () => {
    const created = await createPractice();
    assert.strictEqual(created.expiry, null);

    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'practice-quizzes', created.practiceCode, 'meta.json'), 'utf8'));
    assert.strictEqual(meta.expiry, null);

    const list = await request('GET', '/api/admin/practice', {cookie: adminCookie});
    const entry = list.body.practiceQuizzes.find(item => item.code === created.practiceCode);
    assert.strictEqual(entry.expired, false);
    assert.strictEqual(entry.expiry, null);

    const exists = await request('GET', `/api/practice/${created.practiceCode}/exists`);
    assert.strictEqual(exists.status, 200, exists.text);
    assert.strictEqual(exists.body.exists, true);
});

test('Vergangenes Ablaufdatum wird bei der Erstellung abgelehnt', async () => {
    const result = await request('PUT', '/api/practice', {
        cookie: adminCookie,
        body: {...sampleQuiz('Vergangen'), expiry: new Date(Date.now() - 60_000).toISOString()},
    });
    assert.strictEqual(result.status, 400, result.text);
});

test('abgelaufener Test ist nicht startbar, bleibt aber inklusive Ergebnissen verwaltbar', async () => {
    const expiredAt = daysFromNow(-6);
    writePracticeFixture('XPME', {
        meta: {created: daysFromNow(-20), expiry: expiredAt},
        quiz: sampleQuiz('Abgelaufener Test'),
        results: [sampleResult('Anna')],
    });

    const exists = await request('GET', '/api/practice/XPME/exists');
    assert.strictEqual(exists.status, 410, exists.text);

    const start = await request('GET', '/api/practice/XPME');
    assert.strictEqual(start.status, 410, start.text);

    const list = await request('GET', '/api/admin/practice', {cookie: adminCookie});
    const entry = list.body.practiceQuizzes.find(item => item.code === 'XPME');
    assert.ok(entry, 'abgelaufener Test muss sichtbar bleiben');
    assert.strictEqual(entry.expired, true);
    assert.strictEqual(entry.resultCount, 1);

    const results = await request('POST', '/api/practice/XPME/results', {cookie: adminCookie, body: {}});
    assert.strictEqual(results.status, 200, results.text);
    assert.strictEqual(results.body.meta.totalAttempts, 1);
    assert.strictEqual(results.body.results[0].name, 'Anna');
    sameInstant(results.body.meta.expiry, expiredAt, 'Ablaufdatum muss erhalten bleiben');
});

test('Ablaufdatum kann nachträglich geändert werden', async () => {
    writePracticeFixture('MXPL', {
        meta: {created: daysFromNow(-2), expiry: daysFromNow(-1)},
        results: [sampleResult('Ben')],
    });

    const updated = await request('PUT', '/api/admin/practice/MXPL/expiry', {
        cookie: adminCookie,
        body: {expiry: daysFromNow(30)},
    });
    assert.strictEqual(updated.status, 200, updated.text);
    assert.strictEqual(updated.body.expired, false);

    const exists = await request('GET', '/api/practice/MXPL/exists');
    assert.strictEqual(exists.status, 200, exists.text);

    const forever = await request('PUT', '/api/admin/practice/MXPL/expiry', {cookie: adminCookie, body: {expiry: null}});
    assert.strictEqual(forever.status, 200, forever.text);
    assert.strictEqual(forever.body.expiry, null);
    assert.strictEqual(forever.body.expired, false);

    const results = await request('POST', '/api/practice/MXPL/results', {cookie: adminCookie, body: {}});
    assert.strictEqual(results.status, 200);
    assert.strictEqual(results.body.meta.totalAttempts, 1);
});

test('alte meta.json ohne expiry gilt weiterhin 14 Tage ab Erstellung', async () => {
    writePracticeFixture('LGAC', {meta: {created: daysFromNow(-2)}});
    writePracticeFixture('LGEX', {meta: {created: daysFromNow(-20)}});
    writePracticeFixture('LGNF', {meta: {created: daysFromNow(-2), expiry: null}});

    const list = await request('GET', '/api/admin/practice', {cookie: adminCookie});
    const byCode = Object.fromEntries(list.body.practiceQuizzes.map(item => [item.code, item]));

    assert.strictEqual(byCode.LGAC.expired, false, '2 Tage alter Legacy-Test ist noch aktiv');
    assert.strictEqual(byCode.LGEX.expired, true, '20 Tage alter Legacy-Test gilt als abgelaufen');
    assert.strictEqual(byCode.LGNF.expired, false, 'explizites null bedeutet kein Ablauf');

    assert.ok(!Number.isNaN(new Date(byCode.LGAC.effectiveExpiry).getTime()), 'Legacy-Test muss ein abgeleitetes Ablaufdatum anzeigen');
    assert.ok(new Date(byCode.LGAC.effectiveExpiry).getTime() > Date.now(), 'abgeleitetes Ablaufdatum liegt in der Zukunft');
    assert.strictEqual(byCode.LGNF.effectiveExpiry, null, 'explizites null hat kein effektives Ablaufdatum');

    const legacyExists = await request('GET', '/api/practice/LGEX/exists');
    assert.strictEqual(legacyExists.status, 410);

    const legacyMeta = JSON.parse(fs.readFileSync(path.join(dataDir, 'practice-quizzes', 'LGEX', 'meta.json'), 'utf8'));
    assert.strictEqual(legacyMeta.expiry, undefined, 'Legacy-Datei darf nicht verändert werden');
});

test('Test inklusive Ergebnisse kann manuell gelöscht werden', async () => {
    const created = await createPractice();
    const dir = path.join(dataDir, 'practice-quizzes', created.practiceCode);
    fs.writeFileSync(path.join(dir, 'results', 'attempt.json'), JSON.stringify(sampleResult('Cara')));

    const before = await request('POST', `/api/practice/${created.practiceCode}/results`, {cookie: adminCookie, body: {}});
    assert.strictEqual(before.body.results.length, 1);

    const deleted = await request('DELETE', `/api/admin/practice/${created.practiceCode}`, {cookie: adminCookie});
    assert.strictEqual(deleted.status, 200, deleted.text);
    assert.strictEqual(fs.existsSync(dir), false, 'Testverzeichnis inklusive Ergebnisse muss entfernt sein');

    const again = await request('DELETE', `/api/admin/practice/${created.practiceCode}`, {cookie: adminCookie});
    assert.strictEqual(again.status, 404);
});

test('Verwaltungsendpunkte erfordern Admin-Authentifizierung', async () => {
    const endpoints = [
        ['GET', '/api/admin/quizzes'],
        ['GET', '/api/admin/practice'],
        ['DELETE', '/api/admin/quizzes/ABC123'],
        ['DELETE', '/api/admin/practice/WXYZ'],
        ['PUT', '/api/admin/practice/WXYZ/expiry'],
    ];

    for (const [method, url] of endpoints) {
        const anonymous = await request(method, url, {body: method === 'PUT' ? {expiry: null} : undefined});
        assert.strictEqual(anonymous.status, 401, `${method} ${url} muss ohne Anmeldung 401 liefern`);

        const asTeacher = await request(method, url, {cookie: teacherCookie, body: method === 'PUT' ? {expiry: null} : undefined});
        assert.strictEqual(asTeacher.status, 403, `${method} ${url} muss für Lehrkräfte 403 liefern`);
    }
});

test('Path Traversal über Quiz-ID und Practice-Code wird verhindert', async () => {
    const secret = path.join(dataDir, 'secret.txt');
    fs.writeFileSync(secret, 'geheim');

    const traversalIds = ['..%2F..%2Fsecret', '..%2fsecret.txt', '%2e%2e%2fsecret', 'a/b', '..', 'ABC%2f..%2f..%2fetc'];

    const assertRejected = (status, label) => {
        assert.ok([400, 404].includes(status), `${label} muss abgelehnt werden (war ${status})`);
    };

    for (const id of traversalIds) {
        const quizDelete = await request('DELETE', `/api/admin/quizzes/${id}`, {cookie: adminCookie});
        assertRejected(quizDelete.status, `Quiz-DELETE ${id}`);

        const quizMeta = await request('GET', `/api/admin/quizzes/${id}`, {cookie: adminCookie});
        assertRejected(quizMeta.status, `Quiz-GET ${id}`);

        const quizLoad = await fetch(`${baseUrl}/api/quizzes/${id}`);
        assert.strictEqual(quizLoad.status, 404, `Quiz-Load ${id} darf nichts liefern`);

        const practiceDelete = await request('DELETE', `/api/admin/practice/${id}`, {cookie: adminCookie});
        assertRejected(practiceDelete.status, `Practice-DELETE ${id}`);

        const practiceExpiry = await request('PUT', `/api/admin/practice/${id}/expiry`, {cookie: adminCookie, body: {expiry: null}});
        assertRejected(practiceExpiry.status, `Practice-Expiry ${id}`);
    }

    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'geheim');
    assert.ok(fs.existsSync(path.join(workspace, 'content', 'logo.png')), 'Dateien außerhalb von data/ dürfen nicht erreichbar sein');
});

test('Ungültiges Ablaufdatum wird abgelehnt', async () => {
    writePracticeFixture('BADD', {meta: {created: daysFromNow(-1), expiry: null}});

    const invalid = await request('PUT', '/api/admin/practice/BADD/expiry', {
        cookie: adminCookie,
        body: {expiry: 'kein-datum'},
    });
    assert.strictEqual(invalid.status, 400, invalid.text);

    const past = await request('PUT', '/api/admin/practice/BADD/expiry', {
        cookie: adminCookie,
        body: {expiry: daysFromNow(-3)},
    });
    assert.strictEqual(past.status, 400, past.text);
});

test('Practice-Code-Format wird weiterhin validiert', async () => {
    const invalid = await request('GET', '/api/practice/abc/exists');
    assert.strictEqual(invalid.status, 400);

    const missing = await request('GET', '/api/practice/ZZZZ/exists');
    assert.strictEqual(missing.status, 404);
});