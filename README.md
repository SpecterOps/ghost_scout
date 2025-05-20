# Ghost Scout

Ghost Scout is an LLM assisted OSINT and phishing email generation tool that performs reconnaissance on target companies, finds their employees, and builds profiles for personalized emails based on public sources.

## Overview

This application allows red teamers to:

- Discover target company domains and related domains
- Collect information about email formats and DNS records
- Find potential contacts/employees at target companies
- Scrape sources to enrich contact profiles
- Generate profiles for discovered employees using AI
- Create personalized outreach messages (pretexts) for phishing

## Technologies

- **Backend**: Node.js with Fastify
- **Frontend**: Alpine.js + Tailwind CSS + Socket.io
- **Database**: SQLite
- **Job Processing**: Bee-Queue + Redis
- **HTML to Markdown Conversion**: [MarkItDown-API](https://github.com/fkasler/markitdown-api)
- **Real-time Updates**: Socket.io

## Key Features

- **Domain Discovery**: Add target domains and find related ones through autodiscover techniques
- **Email Format Detection**: Identify company email patterns
- **Contact Discovery**: Find potential contacts using Hunter.io API
- **Source Scraping**: Scrape discovered sources for more information
- **Source Conversion**: HTML to Markdown conversion of sources for better LLM queries
- **Profile Generation**: Generate detailed profiles using AI
- **Pretext Generation**: Create personalized phishing messages with AI
- **Real-time Updates**: Get live feedback as reconnaissance and processing happens

## Project Structure

```bash
/
├── index.js                # Main application entry point
├── db/                     # SQLite database files
├── lib/                    # Library modules
│   ├── dnsQueue.js         # Queue for DNS lookups
│   ├── autodiscover.js     # Domain autodiscovery service
│   ├── hunterService.js    # Hunter.io API integration
│   ├── sourceQueue.js      # Queue for source scraping
│   ├── profileQueue.js     # Queue for profile generation
│   └── pretextQueue.js     # Queue for pretext generation
├── prompt_library/         # YAML templates for AI prompts
└── resources/              # Frontend resources
    ├── pages/              # HTML pages
    ├── js/                 # JavaScript files
    ├── css/                # CSS files
    └── images/             # Image assets
```

## Database Schema

The application uses the following tables:

- **Domain**: Stores target company domains with DNS records
- **SourceDomain**: Tracks domains where source data is found
- **Target**: Stores information about target individuals (prospects)
- **SourceData**: Contains information about URLs where target data was found
- **TargetSourceMap**: Maps the many-to-many relationship between targets and sources
- **Prompt**: Stores LLM prompts for pretext generation
- **Pretext**: Stores generated phishing messages

## Requirements

You will need a Hunter.io API key and an Anthropic API key to use this project in its current state.

## Setup & Installation

1. Clone the repository
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file with your API credentials:

   ```bash
   HUNTER_API_KEY=your_hunter.io_api_key
   ANTHROPIC_API_KEY=your_anthropic_api_key 
   ```

4. Start Redis using Docker (required for job queues):

   ```bash
   docker run --name redis -p 6379:6379 -d redis
   ```

   For Redis with data persistence:

   ```bash
   docker run --name redis -p 6379:6379 -v redis-data:/data -d redis redis-server --appendonly yes
   ```

   Managing the Redis container:

   ```bash
   # Stop Redis
   docker stop redis
   
   # Restart Redis
   docker start redis
   ```

5. Start MarkItDown-API instance from github:

   ```bash
   docker run -d --name markitdown-api -p 8490:8490 ghcr.io/fkasler/markitdown-api:sha-ee4fcafe2cf2f17fbbff77cc7f1b1c81a7c370d2
   ```

6. Start the application:

   ```bash
   node index.js
   ```

7. Access the application at `http://localhost:3000`

## Workflow

1. Add a target company domain
2. Start reconnaissance to find employees and email formats
3. Scrape sources to enrich contact information
4. Generate profiles for discovered contacts
5. Create personalized pretexts for outreach
6. Review, approve, and export pretexts for use in your phishing campaigns

## License

This project is for personal use only and should be used responsibly and ethically for legitimate red team engagements

## Disclaimer

This tool is designed for legitimate penetration testing and red teaming assessments. Always ensure compliance with privacy laws, email regulations, and terms of service of any integrated services. Use responsibly.

## TODO

- [ ] "Dockerize" the application with Docker Compose
- [ ] Add more sources for scraping
- [ ] Add more LLM providers
- [ ] Add more pretext templates
