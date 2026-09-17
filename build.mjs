import fs from 'node:fs';
import path from 'node:path';
fs.rmSync('dist',{recursive:true,force:true});
fs.mkdirSync('dist/server',{recursive:true});
fs.mkdirSync('dist/.openai',{recursive:true});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const assets=Object.fromEntries(fs.readdirSync('public').filter(f=>fs.statSync('public/'+f).isFile()).map(f=>['/'+f,{body:fs.readFileSync('public/'+f,'utf8'),type:types[path.extname(f)]||'text/plain'}]));
// These modules are dependency-free ESM. Inline them without a framework migration.
const parts=['public/seed.js','public/migrations.js','worker/domain.js','worker/index.js'].map(f=>fs.readFileSync(f,'utf8').replace(/^import .*;\n/gm,'').replace(/^export (const|function|class) /gm,'$1 '));
fs.writeFileSync('dist/server/index.js',`const assets=${JSON.stringify(assets)};\n`+parts.join('\n'));
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
if(fs.existsSync('drizzle'))fs.cpSync('drizzle','dist/.openai/drizzle',{recursive:true});
console.log('Built private Fala app with voice, notebook storage, and usage tracking.');
