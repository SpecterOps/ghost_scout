// lib/autodiscover.js
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * Create SOAP request XML to query the Microsoft Autodiscover service
 * @param {string} domain - The domain to search for related domains
 * @returns {string} - XML request body
 */
function createAutodiscoverRequest(domain) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:exm="http://schemas.microsoft.com/exchange/services/2006/messages" 
               xmlns:ext="http://schemas.microsoft.com/exchange/services/2006/types" 
               xmlns:a="http://www.w3.org/2005/08/addressing" 
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" 
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
               xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <soap:Header>
        <a:Action soap:mustUnderstand="1">http://schemas.microsoft.com/exchange/2010/Autodiscover/Autodiscover/GetFederationInformation</a:Action>
        <a:To soap:mustUnderstand="1">https://autodiscover-s.outlook.com/autodiscover/autodiscover.svc</a:To>
        <a:ReplyTo>
            <a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address>
        </a:ReplyTo>
    </soap:Header>
    <soap:Body>
        <GetFederationInformationRequestMessage xmlns="http://schemas.microsoft.com/exchange/2010/Autodiscover">
            <Request>
                <Domain>${domain}</Domain>
            </Request>
        </GetFederationInformationRequestMessage>
    </soap:Body>
</soap:Envelope>`;
}

/**
 * Parse XML response from Autodiscover service
 * @param {string} xmlResponse - XML response from service
 * @returns {Promise<object>} - Parsed response object
 */
async function parseAutodiscoverResponse(xmlResponse) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xmlResponse, { explicitArray: false }, (err, result) => {
            if (err) {
                return reject(err);
            }

            try {
                // Extract the domains from response
                const response = result['s:Envelope']['s:Body']
                    .GetFederationInformationResponseMessage
                    .Response;

                const errorCode = response.ErrorCode;
                const errorMessage = response.ErrorMessage;

                if (errorCode !== 'NoError') {
                    return reject(new Error(`Autodiscover error: ${errorMessage}`));
                }

                // Handle both single domain and multiple domains cases
                let domains = [];
                if (response.Domains && response.Domains.Domain) {
                    domains = Array.isArray(response.Domains.Domain)
                        ? response.Domains.Domain
                        : [response.Domains.Domain];
                }

                resolve({
                    applicationUri: response.ApplicationUri || null,
                    domains: domains
                });
            } catch (error) {
                reject(new Error(`Failed to parse autodiscover response: ${error.message}`));
            }
        });
    });
}

/**
 * Query Microsoft Autodiscover service for related domains
 * @param {string} domain - The domain to query
 * @returns {Promise<object>} - Result object with related domains
 */
async function getRelatedDomains(domain) {
    try {
        const xmlRequest = createAutodiscoverRequest(domain);

        const response = await axios({
            method: 'post',
            url: 'https://autodiscover-s.outlook.com/autodiscover/autodiscover.svc',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': 'http://schemas.microsoft.com/exchange/2010/Autodiscover/Autodiscover/GetFederationInformation'
            },
            data: xmlRequest,
            timeout: 10000 // 10 second timeout
        });

        return await parseAutodiscoverResponse(response.data);
    } catch (error) {
        if (error.response) {
            throw new Error(`Autodiscover request failed with status ${error.response.status}: ${error.message}`);
        }
        throw error;
    }
}

module.exports = {
    getRelatedDomains
};