const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
const fs = require('fs').promises;
const path = require('path');

// Initialize clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// File extensions to analyze
const CODE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go'];

// Get all code files from a directory
async function getCodeFiles(dir, fileList = []) {
  const files = await fs.readdir(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    
    if (stat.isDirectory()) {
      // Skip common directories
      if (!['node_modules', '.git', 'dist', 'build', 'coverage'].includes(file)) {
        await getCodeFiles(filePath, fileList);
      }
    } else {
      const ext = path.extname(file);
      if (CODE_EXTENSIONS.includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  
  return fileList;
}

// Analyze code file with Claude
async function analyzeCodeFile(filePath, code) {
  const fileName = path.basename(filePath);
  
  console.log(`Analyzing ${fileName}...`);
  
  const prompt = `Analyze this code file and provide detailed documentation in JSON format.

File: ${fileName}
Path: ${filePath}

Code:
\`\`\`
${code}
\`\`\`

Return ONLY valid JSON (no markdown, no backticks) with this structure:
{
  "featureName": "Brief feature/component name",
  "description": "What this feature/component does (2-3 sentences)",
  "howItWorks": "High-level explanation of how it works (3-4 sentences)",
  "technicalDetails": "Technical implementation details, key functions, data structures (4-5 sentences)",
  "errorMessages": "List of error messages with explanations and resolutions. Format as: 'ERROR: explanation and how to resolve.' If none, say 'No explicit error messages defined.'",
  "flowchart": "Mermaid flowchart code showing the main logic flow. Use 'graph TD' format."
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  const responseText = message.content[0].text;
  
  // Clean up response - remove markdown backticks if present
  const cleanedResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  
  try {
    return JSON.parse(cleanedResponse);
  } catch (e) {
    console.error(`Failed to parse JSON for ${fileName}:`, e);
    console.error('Response:', cleanedResponse);
    throw e;
  }
}

// Create or update Notion page
async function createNotionPage(fileData, filePath) {
  const { featureName, description, howItWorks, technicalDetails, errorMessages, flowchart } = fileData;
  
  try {
    // Check if page already exists
    const existingPages = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Name',
        title: {
          equals: featureName
        }
      }
    });

    const pageProperties = {
      'Name': {
        title: [{ text: { content: featureName } }]
      },
      'Description': {
        rich_text: [{ text: { content: description } }]
      },
      'How It Works': {
        rich_text: [{ text: { content: howItWorks } }]
      },
      'Technical Details': {
        rich_text: [{ text: { content: technicalDetails } }]
      },
      'Error Messages': {
        rich_text: [{ text: { content: errorMessages } }]
      },
      'Flowchart': {
        rich_text: [{ text: { content: flowchart } }]
      },
      'Last Updated': {
        date: { start: new Date().toISOString() }
      },
      'File Path': {
        rich_text: [{ text: { content: filePath } }]
      }
    };

    // Generate Mermaid chart URL for visual rendering
    const mermaidEncoded = encodeURIComponent(flowchart);
    const mermaidImageUrl = `https://mermaid.ink/img/${Buffer.from(flowchart).toString('base64')}`;

    let pageId;
    if (existingPages.results.length > 0) {
      // Update existing page
      pageId = existingPages.results[0].id;
      await notion.pages.update({
        page_id: pageId,
        properties: pageProperties
      });
      console.log(`✓ Updated: ${featureName}`);
    } else {
      // Create new page
      const newPage = await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties: pageProperties
      });
      pageId = newPage.id;
      console.log(`✓ Created: ${featureName}`);
    }

    // Add flowchart as an image block in the page content
    try {
      await notion.blocks.children.append({
        block_id: pageId,
        children: [
          {
            object: 'block',
            type: 'heading_2',
            heading_2: {
              rich_text: [{ type: 'text', text: { content: 'Visual Flowchart' } }]
            }
          },
          {
            object: 'block',
            type: 'image',
            image: {
              type: 'external',
              external: {
                url: mermaidImageUrl
              }
            }
          },
          {
            object: 'block',
            type: 'heading_2',
            heading_2: {
              rich_text: [{ type: 'text', text: { content: 'Mermaid Code' } }]
            }
          },
          {
            object: 'block',
            type: 'code',
            code: {
              rich_text: [{ type: 'text', text: { content: flowchart } }],
              language: 'mermaid'
            }
          }
        ]
      });
      console.log(`  ✓ Added visual flowchart to page`);
    } catch (blockError) {
      console.error(`  Warning: Could not add flowchart blocks: ${blockError.message}`);
    }
  } catch (error) {
    console.error(`Error creating/updating Notion page for ${featureName}:`, error);
    throw error;
  }
}

// Main function
async function main() {
  try {
    const repoPath = process.argv[2] || './repo';
    
    console.log(`Scanning repository at: ${repoPath}`);
    
    // Get all code files
    const codeFiles = await getCodeFiles(repoPath);
    console.log(`Found ${codeFiles.length} code files`);
    
    // Limit files for cost control (remove this in production)
    const filesToProcess = codeFiles.slice(0, 20);
    console.log(`Processing ${filesToProcess.length} files (limited for cost control)`);
    
    // Process each file
    for (const filePath of filesToProcess) {
      try {
        const code = await fs.readFile(filePath, 'utf-8');
        
        // Skip very large files (>10KB) to control costs
        if (code.length > 10000) {
          console.log(`Skipping ${filePath} (too large)`);
          continue;
        }
        
        const analysis = await analyzeCodeFile(filePath, code);
        await createNotionPage(analysis, filePath);
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
      }
    }
    
    console.log('\n✓ Documentation generation complete!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
