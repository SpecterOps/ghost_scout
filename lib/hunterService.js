// lib/hunterService.js
const axios = require('axios');

async function searchDomain(domain, apiKey, limit = 20) {
    try {
        const response = await axios.get('https://api.hunter.io/v2/domain-search', {
            params: {
                domain,
                limit,
                api_key: apiKey
            }
        });

        return response.data;
    } catch (error) {
        console.error(`Hunter.io API error: ${error.message}`);
        throw error;
    }
}

module.exports = {
    searchDomain
};