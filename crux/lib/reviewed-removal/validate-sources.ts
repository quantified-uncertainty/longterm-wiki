import fs from 'node:fs';
import path from 'node:path';
import { compile } from '@mdx-js/mdx';
import matter from 'gray-matter';
import { parseDocument } from 'yaml';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { runCheck } from '../../validate/validate-reviewed-removal.ts';
import { validatePlan, type Plan } from './model.ts';
const [bundle]=process.argv.slice(2);
if(!bundle)throw new Error('Usage: validate-sources.ts BUNDLE');
const plan:Plan=JSON.parse(fs.readFileSync(path.join(bundle,'draft-plan.json'),'utf8'));
validatePlan(plan);
const failures:string[]=[],preexisting:string[]=[];
for(const file of plan.files){
  if(file.after==null)continue;
  if(file.file.endsWith('.yaml')){
    const document=parseDocument(file.after);if(document.errors.length)failures.push(file.file+': '+document.errors[0].message);
  }else if(file.file.endsWith('.mdx')){
    try{await compile(matter(file.after).content,{remarkPlugins:[remarkGfm,remarkMath]});}
    catch(error){
      try{await compile(matter(file.before).content,{remarkPlugins:[remarkGfm,remarkMath]});failures.push(file.file+': '+String(error));}
      catch{preexisting.push(file.file+': '+String(error));}
    }
  }
}
const check=runCheck(plan);
const report={passed:!failures.length&&check.passed,files:plan.files.length,editedArticles:plan.files.filter(f=>f.file.endsWith('.mdx')&&f.after!==null).length,deletedArticles:plan.files.filter(f=>f.file.endsWith('.mdx')&&f.after===null).length,failures,preexistingCompileErrors:preexisting,identityViolations:check.violations};
fs.writeFileSync(path.join(bundle,'reports/source-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!report.passed)process.exitCode=1;
