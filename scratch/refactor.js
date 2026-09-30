const fs = require('fs');
const path = require('path');

function refactorFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Add async to route handlers
    content = content.replace(/router\.(get|post|put|patch|delete)\(([^,]+),\s*(authAdmin|authGuestOrAdmin|authCheckinStaff|staffLoginLimiter|),\s*\((req,\s*res)\)\s*=>\s*\{/g, (match, method, route, middleware, args) => {
        if (middleware) {
            return `router.${method}(${route}, ${middleware}, async (${args}) => {`;
        }
    });

    content = content.replace(/router\.(get|post|put|patch|delete)\(([^,]+),\s*\((req,\s*res)\)\s*=>\s*\{/g, (match, method, route, args) => {
        return `router.${method}(${route}, async (${args}) => {`;
    });

    // Make db calls async
    content = content.replace(/db\.prepare\(([\s\S]*?)\)\.(get|all|run)\(([\s\S]*?)\)/g, 'await db.prepare($1).$2($3)');

    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Refactored', filePath);
}

refactorFile(path.join(__dirname, '../backend/routes/auth.js'));
refactorFile(path.join(__dirname, '../backend/routes/comment.js'));
