const path = require("path");
const fs = require("fs").promises;
const {quizzesFolder} = require("./file");
const {decompressQuiz} = require("./quiz");

const quizFileExtension = '.quizzle';
const quizIdPattern = /^[A-Z0-9]+$/i;

const isSafeQuizId = (quizId) => typeof quizId === 'string' && quizIdPattern.test(quizId);

const resolveQuizPath = (quizId) => {
    if (!isSafeQuizId(quizId)) return null;
    return path.join(quizzesFolder, `${quizId.toUpperCase()}${quizFileExtension}`);
};

const readSavedQuiz = async (quizId) => {
    const quizPath = resolveQuizPath(quizId);
    if (!quizPath) return null;

    try {
        return decompressQuiz(await fs.readFile(quizPath));
    } catch {
        return null;
    }
};

const listSavedQuizzes = async () => {
    let files;
    try {
        files = await fs.readdir(quizzesFolder);
    } catch {
        return [];
    }

    const entries = [];

    for (const file of files) {
        if (!file.endsWith(quizFileExtension)) continue;

        const quizId = file.slice(0, -quizFileExtension.length);
        if (!isSafeQuizId(quizId)) continue;

        const stats = await fs.stat(path.join(quizzesFolder, file));
        const quiz = await readSavedQuiz(quizId);

        entries.push({
            quizId,
            title: quiz?.title || quizId,
            questionCount: Array.isArray(quiz?.questions) ? quiz.questions.length : 0,
            created: stats.birthtime.toISOString(),
            modified: stats.mtime.toISOString(),
        });
    }

    return entries.sort((a, b) => new Date(b.created) - new Date(a.created));
};

const deleteSavedQuiz = async (quizId) => {
    const quizPath = resolveQuizPath(quizId);
    if (!quizPath) return false;

    try {
        await fs.access(quizPath);
    } catch {
        return false;
    }

    await fs.unlink(quizPath);
    return true;
};

module.exports = {
    quizIdPattern,
    isSafeQuizId,
    resolveQuizPath,
    readSavedQuiz,
    listSavedQuizzes,
    deleteSavedQuiz,
};