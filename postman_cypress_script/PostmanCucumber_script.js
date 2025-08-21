const fs = require('fs');
const path = require('path');

const OUTPUT_FEATURE_DIR = path.join(__dirname, 'cypress', 'e2e', 'postman');
const OUTPUT_STEP_FILE = path.join(__dirname, 'cypress', 'e2e', 'commonPostmanSteps.js');
const cypressConfig = path.join(__dirname, 'cypress.env.json');
//const BASE_URL_REGEX = /^(https?:\/\/[^/]+|{{[^}]+}})/i;

const stepMethods = new Set();
const stepUsers = new Set();
const seenScenariosByFile = new Map(); // Per-file dedupe

// -------------------- Utilities --------------------
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadPostmanEnv(envFile) {
  const envJson = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  const vars = {};
  (envJson.values || []).forEach(v => {
    if (v.enabled !== false) {
      vars[v.key] = v.value;
    }
  });
  return vars;
}

function readPostmanEnvs(item) {
  const envs = JSON.parse(fs.readFileSync(cypressConfig, "utf8"))
  const userID = (item.bearer[0].value).replace(/{{|}}/g, "")
  
  return {"id": userID,
          "value": envs[userID]}
}

// -------------------- Step Definition Generator --------------------
function generateCommonStepFile() {
  let code = `import { When, Then } from '@badeball/cypress-cucumber-preprocessor';\n\n`;
  
  stepUsers.forEach(authUsers => {

    stepMethods.forEach(method => {
      code += `When('User {string} send a ${method} request to {string} with:', (user, endpoint, dataTable) => {\n`;
      code += `  const resolvedEndpoint = endpoint.replace(/{{(\\w+)}}/g, (_, name) => Cypress.env(name));\n`;
      code += `  const rows = dataTable.raw();\n`;
      code += `  const headers = {};\n`;
      code += `  let body = {};\n`;
      code += `  rows.forEach(([key, value]) => {\n`;
      code += `    if (key.toLowerCase().startsWith('header:')) {\n`;
      code += `      headers[key.replace('header:', '')] = value;\n`;
      code += `    } else if (key.toLowerCase().startsWith('body:')) {\n`;
      code += `      try { body[key.replace('body:', '')] = JSON.parse(value); } catch { body[key.replace('body:', '')] = value; }\n`;
      code += `    }\n`;
      code += `  });\n`;
      code += `  cy.request({\n`;
      code += `    method: '${method}',\n`;
      code += `    url: \`\${Cypress.env('baseUrl')}\${resolvedEndpoint}\`,\n`;
      code += `    headers,\n`;
      code += `    auth: \`\${Cypress.env('${authUsers.id}')}\`,\n`,
      code += `    body: Object.keys(body).length ? body : undefined,\n`;
      code += `  }).then((response) => {\n`;
      code += `    Cypress.env('lastResponse', response);\n`;
      code += `  });\n`;
      code += `});\n\n`;
    });
    
    code += `Then('the response should match:', (dataTable) => {\n`;
    code += `  const response = Cypress.env('lastResponse');\n`;
    code += `  const rows = dataTable.raw();\n`;
    code += `  rows.forEach(([key, expected]) => {\n`;
    code += `    if (key.toLowerCase() === 'status') {\n`;
    code += `      expect(response.status).to.be.oneOf(expected.split(',').map(Number));\n`;
    code += `    } else {\n`;
    code += `      const body = response.body;\n`;
    code += `      const val = key.split('.').reduce((o, k) => (o ? o[k] : undefined), body);\n`;
    code += `      const parsedExpected = isNaN(expected) ? expected : Number(expected);\n`;
    code += `      expect(val).to.eql(parsedExpected);\n`;
    code += `    }\n`;
    code += `  });\n`;
    code += `});\n`;
  })
    
    ensureDirSync(path.dirname(OUTPUT_STEP_FILE));
    fs.writeFileSync(OUTPUT_STEP_FILE, code, 'utf8');
    console.log(`✅ Step definitions written to ${OUTPUT_STEP_FILE}`);
  }
  
// -------------------- Feature Writer --------------------
function addScenarioToFeatureFile(folderPath, method, endpointPath, scenarioName, headers, auth, body, assertions) {
  const featureDir = path.join(OUTPUT_FEATURE_DIR, folderPath);
  ensureDirSync(featureDir);

  const featureFile = path.join(featureDir, `${path.basename(folderPath)}.feature`);

  if (!seenScenariosByFile.has(featureFile)) {
    seenScenariosByFile.set(featureFile, new Set());
  }
  const fileSeen = seenScenariosByFile.get(featureFile);
  const scenarioKey = `${method}:${endpointPath}:${JSON.stringify(headers)}:${JSON.stringify(body)}:${JSON.stringify(assertions)}`;
  if (fileSeen.has(scenarioKey)) return;
  fileSeen.add(scenarioKey);

  let content = '';
  if (fs.existsSync(featureFile)) {
    content = fs.readFileSync(featureFile, 'utf8');
  } else {
    content = `Feature: ${path.basename(folderPath)}\n\n`;
  }

  content += `  Scenario: ${scenarioName}\n`;
  content += `    When User "${auth.id}" sends a ${method} request to "${endpointPath}" with:\n`;

  // Headers
  headers.forEach(h => {
    content += `      | header:${h.key} | ${h.value} |\n`;
  });

  // Body
  if (body && Object.keys(body).length > 0) {
    Object.entries(body).forEach(([k, v]) => {
      if (typeof v === 'object') v = JSON.stringify(v);
      content += `      | body:${k} | ${v} |\n`;
    });
  }

  // Assertions
  if (assertions.length > 0) {
    content += `    Then the response should match:\n`;
    assertions.forEach(a => {
      content += `      | ${a.key} | ${a.value} |\n`;
    });
  }
  content += `\n`;

  fs.writeFileSync(featureFile, content, 'utf8');
}

// -------------------- Postman Test Parser --------------------
function extractAssertionsFromTests(eventArray) {
  if (!Array.isArray(eventArray)) return [];
  const assertions = [];

  eventArray.forEach(ev => {
    if (ev.listen === 'test' && ev.script && ev.script.exec) {
      const scriptText = ev.script.exec.join("\n");

      //1. handling tests where assertions are made against lists/variables   
      const loopMatch = scriptText.match(/(\w+)\s*=\s*\[([^\]]+)\][\s\S]+?\1\.forEach/);
      if (loopMatch) {
        const varName = loopMatch[1]; // e.g., groupList
        const rawValues = loopMatch[2].split(',').map(v => v.trim().replace(/['"]/g, ''));
        rawValues.forEach(val => {
          assertions.push({
            key: `GroupName`,
            value: val
          });
        });
      }
   
      // 2. Handle single-line pm.expect assertions 

      ev.script.exec.forEach(line => {
        let trimmed = line.trim();

        // Status codes
        let statusMatch = trimmed.match(/response\.to\.have\.status\((\d+)\)/);
        if (statusMatch) {
          assertions.push({ key: 'status', value: statusMatch[1] });
          return;
        }

        // Generic pm.expect(...)
        let expectMatch = trimmed.match(/pm\.expect\((.+?)\)\.to\.(.+)/);
        if (expectMatch) {
          let actualExpr = expectMatch[1].trim();
          let assertionExpr = expectMatch[2].trim();

          if (actualExpr.includes('response.json()')) {
            let pathMatch = actualExpr.match(/response\.json\(\)\.([\w.]+)/);
            let key = pathMatch ? pathMatch[1] : 'body';
            let valueMatch = assertionExpr.match(/(?:equal|eql|contain|include)\((.+?)\)/);
            if (valueMatch) {
              assertions.push({
                key,
                value: valueMatch[1].replace(/['"]/g, '').trim()
              });
            }
          }
        }
      });
    }
  });

  return assertions;
}

// -------------------- Recursive Processor --------------------
function processItems(items, currentFolder = '') {
  items.forEach(item => {
    if (item.item) {
      const newFolder = path.join(currentFolder, item.name.replace(/\s+/g, '_'));
      processItems(item.item, newFolder);
    } else if (item.request) {
      const method = item.request.method.toUpperCase();
      const auth = item.request.auth
      stepMethods.add(method);
      
      const rawUrl = item.request.url?.raw || '';
     // const endpointPath = replaceVarsForFeature(extractPathOnly(item.request.url.path));
      const endpointPath = (item.request.url.path).join("/")

      const headers = (item.request.header || []).map(h => ({ key: h.key, value: h.value }));

      //authentication\
      let requestAuthentication = {}
      if(item.request.auth) { 
        requestAuthentication = readPostmanEnvs(item.request.auth)
        stepUsers.add(requestAuthentication)
     }

      // Body
      let body = {};
      if (item.request.body) {
        const mode = item.request.body.mode;
        if (mode === 'urlencoded') {
          (item.request.body.urlencoded || []).forEach(p => {
            if (p.disabled !== true) body[p.key] = p.value;
          });
        } else if (mode === 'formdata') {
          (item.request.body.formdata || []).forEach(p => {
            if (p.disabled !== true) body[p.key] = p.value;
          });
        } else if (mode === 'graphql') {
          body = {
            query: item.request.body.graphql.query,
            variables: JSON.stringify(item.request.body.graphql.variables || {})
          };
        } else if (mode === 'file') {
          body = { file: item.request.body.file?.src || '<file upload>' };
        }
        else { //(mode === 'raw') {
          try {
            body = JSON.parse(item.request.body.raw);
          } catch {
            body = { raw: item.request.body.raw };
          }
        }
      }

      const assertions = extractAssertionsFromTests(item.event);

      addScenarioToFeatureFile(
        currentFolder || 'root',
        method,
        endpointPath,
        item.name,
        headers,
        requestAuthentication,
        body,
        assertions
      );
    }
  });
}

// -------------------- Main Conversion --------------------
function convertPostmanCollection(collectionFile, envFile) {
  const collection = JSON.parse(fs.readFileSync(collectionFile, 'utf8'));
  if (!collection.item) {
    console.error('❌ Invalid Postman collection');
    return;
  }

  if (envFile) {
    const envVars = loadPostmanEnv(envFile);
    fs.writeFileSync(path.join(__dirname, 'cypress.env.json'), JSON.stringify(envVars, null, 2));
    console.log(`✅ Environment variables written to cypress.env.json`);
  }

  processItems(collection.item);
  generateCommonStepFile();
  console.log(`✅ Features written to ${OUTPUT_FEATURE_DIR}`);
}

// -------------------- CLI Entry --------------------
const [collectionPath, envPath] = process.argv.slice(2);
if (!collectionPath) {
  console.error('Usage: node convert-postman-to-cucumber.js <collection.json> [environment.json]');
  process.exit(1);
}

convertPostmanCollection(collectionPath, envPath);
