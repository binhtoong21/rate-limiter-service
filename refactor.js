const fs = require('fs');
const path = require('path');

const directoryPath = path.join(__dirname, 'src/routes');

function replaceInFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Replace error responses: { error: 'CODE', message: '...' } -> { success: false, error: { code: 'CODE', message: '...' } }
    // Note: some files already have the new format, so we only target the old format.
    // Old format regex: send\(\{ error: '([^']+)', message: ([^\}]+) \}\)
    content = content.replace(/send\(\{\s*error:\s*'([^']+)',\s*message:\s*([^\}]+?)\s*\}\)/g, "send({ success: false, error: { code: '$1', message: $2 } })");

    // Replace success responses: { data: ... } -> { success: true, data: ... }
    // Regex: send\(\{ data: 
    // Wait, some might have other fields or be multiline.
    // Let's just do simple replacements.
    
    // find send({ data:
    content = content.replace(/send\(\{\s*data:/g, "send({ success: true, data:");
    
    // find send({\n  data:
    // This is covered by \s*

    fs.writeFileSync(filePath, content, 'utf8');
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            walkDir(fullPath);
        } else if (fullPath.endsWith('.ts')) {
            replaceInFile(fullPath);
        }
    }
}

walkDir(directoryPath);
console.log('Done!');
