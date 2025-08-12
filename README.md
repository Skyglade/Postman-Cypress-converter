# Postman -> Cypress Converter

# <ins> Intro </ins>
Due to the issues with Postman requiring sign in, I created a script to allow for projects to convert Postman collection.json files into Cypress tests based on their folder directory level. 

Tests within a postman folder will be compiled into one test script used for Cypress. This is to allow for scenraios where projects might require multiple API calls to complete scenarios / any test setup needed. 


# Running

## PostmanCypress_script.js

<sub> This script is to convert a Postman collection into Cypress </sub>

To run the script: 
> node PostmanCypress_script.js ***{Path to Collection}*** ***{Path to Output}***

Example:
>> node PostmanCypress_script.js MyCollection.postman_collection.json cypress/e2e/postman_converted


## PostmanCucumber_script.js
<sub> This script is to convert a Postman collection into Cucumber compatible format for Cypress </sub>

> node PostmanCucumber_script.js <collection.json> <postman_environment_file> 

Example: 
    > node PostmanCucumber_script.js testData/MyCollection.postman_collection.json testData/test.postman_environment.json


### <ins> Output: </ins>
- cypress/e2e/postman/*
- cypress/e2e/commonPostmanSteps.js
- Postman.env.js

#### commonPostmanSteps.js
    This file will contain all the step defintions needed for the Postman collection. it will attempt to reduce duplicates across the Postman tests to ensure ease of maintainance, 

#### cypress/e2e/postman/*
    This location will contain all converted Postman tests as features. These will be feature files that contain all api calls completed under the selected folder directory. This should help to cluster any test scenarios that require multiple api calls. 


#### Postman.env.js
    To avoid overwriting the Cypress.config.js file, Postman.env.js will be created in order to move over any postman environment varibles. These might include hostnames, users, passwords etc. 

**_After running this script ensure you copy the contents of this and move to the relevant env file used for cypress. (Commonly: cypress.config.js witin the "env" section)_** 