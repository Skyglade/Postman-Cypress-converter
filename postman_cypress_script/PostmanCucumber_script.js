const fs = require('fs');
const path = require('path');

const OUTPUT_FEATURE_DIR = path.join(__dirname, 'cypress', 'e2e', 'postman');
const OUTPUT_STEP_FILE = path.join(__dirname, 'cypress', 'e2e', 'commonPostmanSteps.js');
const BASE_URL_REGEX = /^https?:\/\/[^/]+/i;

const stepMethods = new Set();
const seenScenariosByFile = new Map(); // Per-file dedupe

// -------------------- Utilities --------------------
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extractPathOnly(rawUrl) {
  if (!rawUrl) return '';
  return rawUrl.replace(BASE_URL_REGEX, '');
}

function replaceVarsForFeature(str) {
  return str.replace(/{{(\w+)}}/g, '{{$1}}'); // Keep placeholders in Gherkin
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

// -------------------- Step Definition Generator --------------------
function generateCommonStepFile() {
  let code = `import { When, Then } from '@badeball/cypress-cucumber-preprocessor';\n\n`;

  stepMethods.forEach(method => {
    code += `When('I send a ${method} request to {string}', (endpoint) => {\n`;
    code += `  const resolvedEndpoint = endpoint.replace(/{{(\\w+)}}/g, (_, name) => Cypress.env(name));\n`;
    code += `  cy.request({\n`;
    code += `    method: '${method}',\n`;
    code += `    url: \`\${Cypress.env('baseUrl')}\${resolvedEndpoint}\`,\n`;
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

  ensureDirSync(path.dirname(OUTPUT_STEP_FILE));
  fs.writeFileSync(OUTPUT_STEP_FILE, code, 'utf8');
  console.log(`✅ Step definitions written to ${OUTPUT_STEP_FILE}`);
}

// -------------------- Feature Writer --------------------
function addScenarioToFeatureFile(folderPath, method, endpointPath, scenarioName, assertions) {
  const featureDir = path.join(OUTPUT_FEATURE_DIR, folderPath);
  ensureDirSync(featureDir);

  const featureFile = path.join(featureDir, `${path.basename(folderPath)}.feature`);

  if (!seenScenariosByFile.has(featureFile)) {
    seenScenariosByFile.set(featureFile, new Set());
  }
  const fileSeen = seenScenariosByFile.get(featureFile);
  const scenarioKey = `${method}:${endpointPath}:${JSON.stringify(assertions)}`;
  if (fileSeen.has(scenarioKey)) return;
  fileSeen.add(scenarioKey);

  let content = '';
  if (fs.existsSync(featureFile)) {
    content = fs.readFileSync(featureFile, 'utf8');
  } else {
    content = `Feature: ${path.basename(folderPath)}\n\n`;
  }

  content += `  Scenario: ${scenarioName}\n`;
  content += `    When I send a ${method} request to "${endpointPath}"\n`;
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
      ev.script.exec.forEach(line => {
        // pm.response.to.have.status(NUM)
        let statusHaveMatch = line.match(/pm\.response\.to\.have\.status\((\d+)\)/);
        if (statusHaveMatch) {
          assertions.push({ key: 'status', value: statusHaveMatch[1] });
        }

        // Status code exact match
        let statusMatch = line.match(/response\.code\s*===?\s*(\d+)/);
        if (statusMatch) {
          assertions.push({ key: 'status', value: statusMatch[1] });
        }

        // pm.expect(pm.response.code).to.equal(NUM) or .eql(NUM)
        statusMatch = line.match(/response\.code\)\.to\.(?:equal|eql)\((\d+)\)/);
        if (statusMatch) {
          assertions.push({ key: 'status', value: statusMatch[1] });
        }

        // pm.expect(pm.response.code).to.be.oneOf([200, 201])
        const statusArrayMatch = line.match(/response\.code\)\.to\.be\.oneOf\(\[([0-9,\s]+)\]\)/);
        if (statusArrayMatch) {
          const codes = statusArrayMatch[1].split(',').map(c => c.trim());
          assertions.push({ key: 'status', value: codes.join(',') });
        }

        // pm.expect(pm.response.json().foo.bar).to.equal(...)
        const deepJsonMatch = line.match(/response\.json\(\)(?:\.(\w+))+(.*?)to\.(?:equal|eql)\((.+?)\)/);
        if (deepJsonMatch) {
          const pathMatch = line.match(/response\.json\(\)\.([\w.]+)/);
          if (pathMatch) {
            assertions.push({
              key: pathMatch[1],
              value: deepJsonMatch[3].replace(/['"]/g, '').trim()
            });
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
      stepMethods.add(method);

      const rawUrl = item.request.url?.raw || '';
      const endpointPath = replaceVarsForFeature(extractPathOnly(rawUrl));

      const assertions = extractAssertionsFromTests(item.event);

      addScenarioToFeatureFile(
        currentFolder || 'root',
        method,
        endpointPath,
        item.name,
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
    fs.writeFileSync(path.join(__dirname, 'Postman.env.js'), JSON.stringify(envVars, null, 2));
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
