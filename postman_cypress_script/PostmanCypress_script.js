// postman-to-cypress-multi-deep.js
// Usage: node postman-to-cypress-multi-deep.js collection.json cypress/e2e/postman_converted

const fs = require('fs');
const path = require('path');

if (process.argv.length < 4) {
  console.error('Usage: node postman-to-cypress-multi-deep.js <input_postman.json> <output_dir>');
  process.exit(1);
}

const inputFile = process.argv[2];
const outputDir = process.argv[3];
const postmanData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

function replacePostmanVars(str) {
  return str.replace(/{{(\w+)}}/g, (_, varName) => `\${Cypress.env('${varName}')}`);
}

function safeName(name) {
  return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function generateTestCode(folderName, requests) {
  let code = `/// <reference types="cypress" />\n\ndescribe('${folderName}', () => {\n`;

  requests.forEach(item => {
    const method = item.request.method;
    const url = replacePostmanVars(item.request.url.raw || '');
    const headers = {};
    (item.request.header || []).forEach(h => {
      headers[h.key] = replacePostmanVars(h.value);
    });
    const body = item.request.body?.raw || '';

    code += `  it('${safeName(item.name)}', () => {\n`;
    code += `    cy.request({\n`;
    code += `      method: '${method}',\n`;
    code += `      url: \`${url}\`,\n`;
    if (Object.keys(headers).length) {
      code += `      headers: ${JSON.stringify(headers, null, 6)},\n`;
    }
    if (body) {
      let replacedBody = replacePostmanVars(body);
      try {
        code += `      body: ${JSON.stringify(JSON.parse(replacedBody), null, 6)},\n`;
      } catch {
        code += `      body: \`${replacedBody}\`,\n`;
      }
    }
    code += `    }).then((response) => {\n`;
    code += `      expect(response.status).to.eq(200);\n`;
    code += `    });\n`;
    code += `  });\n`;
  });

  code += `});\n`;
  return code;
}

function processFolder(folderName, items, folderPathParts) {
  const requests = items.filter(i => i.request);

  if (requests.length) {
    const outputFilePath = path.join(outputDir, ...folderPathParts, `${safeName(folderName)}.cy.js`);
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
    fs.writeFileSync(outputFilePath, generateTestCode(folderName, requests), 'utf8');
    console.log(`✅ Generated ${outputFilePath}`);
  }

  // Recurse into subfolders
  items.filter(i => i.item).forEach(subFolder => {
    processFolder(
      subFolder.name,
      subFolder.item,
      [...folderPathParts, safeName(subFolder.name)]
    );
  });
}

// Start recursion at top-level
postmanData.item.forEach(topFolder => {
  if (topFolder.item) {
    processFolder(topFolder.name, topFolder.item, [safeName(topFolder.name)]);
  } else if (topFolder.request) {
    // Top-level requests with no folder
    const outputFilePath = path.join(outputDir, `root_requests.cy.js`);
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
    fs.writeFileSync(outputFilePath, generateTestCode('Root Requests', [topFolder]), 'utf8');
    console.log(`✅ Generated ${outputFilePath}`);
  }
});
