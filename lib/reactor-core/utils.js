const fs = require('fs');
const path = require('path');

function sanitizeName(name) {
    // Mimic the main.js logic: keep it simple and safe for all OSs
    return name.replace(/[^a-zA-Z0-9\- ]/g, '').trim();
}

function checkCreateDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function readFile(filePath) {
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    throw new Error(`File ${filePath} does not exist.`);
}

module.exports = {
    sanitizeName,
    checkCreateDir,
    readFile
};
