const app = require('express').Router();
const {requireAdmin} = require('../middleware/auth');
const {validateSchema} = require('../utils/error');
const {practiceExpiryValidation} = require('../validations/quiz');
const {listSavedQuizzes, readSavedQuiz, deleteSavedQuiz, isSafeQuizId} = require('../utils/savedQuizzes');
const {
    listPracticeQuizzes,
    readPracticeMeta,
    writePracticeMeta,
    deletePracticeQuiz,
    practiceQuizExists,
    isSafePracticeCode,
    getEffectiveExpiry,
    isPracticeExpired,
} = require('../utils/practice');

const findPracticeQuiz = (code) => isSafePracticeCode(code);

app.get('/quizzes', requireAdmin, async (req, res) => {
    try {
        res.json({quizzes: await listSavedQuizzes()});
    } catch (error) {
        console.error('Error listing quizzes:', error);
        res.status(500).json({message: 'Quizze konnten nicht geladen werden.'});
    }
});

app.get('/quizzes/:quizId', requireAdmin, async (req, res) => {
    try {
        const {quizId} = req.params;

        if (!isSafeQuizId(quizId)) {
            return res.status(400).json({message: 'Ungültige Quiz-ID.'});
        }

        const quiz = await readSavedQuiz(quizId);
        if (!quiz) {
            return res.status(404).json({message: 'Quiz nicht gefunden.'});
        }

        res.json({
            quizId: quizId.toUpperCase(),
            title: quiz.title || quizId,
            questionCount: Array.isArray(quiz.questions) ? quiz.questions.length : 0,
            questions: quiz.questions || [],
            settings: quiz.settings || {}
        });
    } catch (error) {
        console.error('Error loading quiz metadata:', error);
        res.status(500).json({message: 'Quiz konnte nicht geladen werden.'});
    }
});

app.delete('/quizzes/:quizId', requireAdmin, async (req, res) => {
    try {
        const {quizId} = req.params;

        if (!isSafeQuizId(quizId)) {
            return res.status(400).json({message: 'Ungültige Quiz-ID.'});
        }

        if (!await deleteSavedQuiz(quizId)) {
            return res.status(404).json({message: 'Quiz nicht gefunden.'});
        }

        res.json({success: true});
    } catch (error) {
        console.error('Error deleting quiz:', error);
        res.status(500).json({message: 'Quiz konnte nicht gelöscht werden.'});
    }
});

app.get('/practice', requireAdmin, async (req, res) => {
    try {
        res.json({practiceQuizzes: await listPracticeQuizzes()});
    } catch (error) {
        console.error('Error listing practice quizzes:', error);
        res.status(500).json({message: 'Tests konnten nicht geladen werden.'});
    }
});

app.get('/practice/:code', requireAdmin, async (req, res) => {
    try {
        const {code} = req.params;

        if (!findPracticeQuiz(code)) {
            return res.status(400).json({message: 'Ungültiger Practice-Code.'});
        }

        if (!await practiceQuizExists(code)) {
            return res.status(404).json({message: 'Test nicht gefunden.'});
        }

        const meta = await readPracticeMeta(code) || {};
        const expiry = getEffectiveExpiry(meta);

        res.json({
            code,
            created: meta.created || null,
            expiry: meta.expiry || null,
            effectiveExpiry: expiry ? expiry.toISOString() : null,
            expired: isPracticeExpired(meta),
        });
    } catch (error) {
        console.error('Error loading practice quiz metadata:', error);
        res.status(500).json({message: 'Test konnte nicht geladen werden.'});
    }
});

app.put('/practice/:code/expiry', requireAdmin, async (req, res) => {
    try {
        const {code} = req.params;
        const {expiry} = req.body;

        if (!findPracticeQuiz(code)) {
            return res.status(400).json({message: 'Ungültiger Practice-Code.'});
        }

        if (validateSchema(res, practiceExpiryValidation, expiry)) return;

        if (!await practiceQuizExists(code)) {
            return res.status(404).json({message: 'Test nicht gefunden.'});
        }

        const meta = await readPracticeMeta(code) || {created: new Date().toISOString()};
        meta.expiry = expiry ? new Date(expiry).toISOString() : null;

        await writePracticeMeta(code, meta);

        res.json({
            success: true,
            expiry: meta.expiry,
            expired: isPracticeExpired(meta),
        });
    } catch (error) {
        console.error('Error updating practice quiz expiry:', error);
        res.status(500).json({message: 'Ablaufdatum konnte nicht gespeichert werden.'});
    }
});

app.delete('/practice/:code', requireAdmin, async (req, res) => {
    try {
        const {code} = req.params;

        if (!findPracticeQuiz(code)) {
            return res.status(400).json({message: 'Ungültiger Practice-Code.'});
        }

        if (!await deletePracticeQuiz(code)) {
            return res.status(404).json({message: 'Test nicht gefunden.'});
        }

        res.json({success: true});
    } catch (error) {
        console.error('Error deleting practice quiz:', error);
        res.status(500).json({message: 'Test konnte nicht gelöscht werden.'});
    }
});

module.exports = app;