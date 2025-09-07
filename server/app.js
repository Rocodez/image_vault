import express from 'express';
import cors from 'cors';
import { body, validationResult } from 'express-validator';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { DynamoDBClient, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ AWS Configuration
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const dynamoDBClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// ✅ Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// ✅ Generate presigned POST URL for direct S3 upload
app.post('/api/generate-presigned-url', [
  body('fileName').isString().notEmpty(),
  body('fileType').isString().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { fileName, fileType } = req.body;
    const key = `images/${Date.now()}-${fileName.replace(/\s+/g, '-')}`;

    console.log("🔑 Generating presigned URL for:", key, "type:", fileType);

    // ✅ FIXED: Remove Content-Type validation
    const { url, fields } = await createPresignedPost(s3Client, {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Conditions: [
        ['content-length-range', 0, 10485760] // ONLY size validation
      ],
      Expires: 300
    });

    res.json({ url, fields, key });
  } catch (error) {
    console.error("❌ Presigned URL error:", error);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// ✅ Save image metadata to DynamoDB
app.post('/api/save-metadata', [
  body('key').isString().notEmpty(),
  body('caption').isString().optional(),
  body('tags').isArray().optional()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { key, caption, tags } = req.body;
    const item = {
      imageId: key,
      caption: caption || '',
      tags: tags || [],
      uploadTime: Date.now(),
      uploaderId: req.ip
    };

    const command = new PutItemCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Item: marshall(item)
    });

    await dynamoDBClient.send(command);
    res.json({ success: true, message: 'Metadata saved' });
  } catch (error) {
    console.error('❌ Save metadata error:', error);
    res.status(500).json({ error: 'Failed to save metadata' });
  }
});

// ✅ Search images by keywords
// ✅ Search images by keywords (DEBUG VERSION)
// ✅ Search images by keywords (FULLY FUNCTIONAL)
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    console.log('🔍 Search query received:', q || '(empty)');
    
    // First, get ALL items from DynamoDB
    const scanCommand = new ScanCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME
    });

    const result = await dynamoDBClient.send(scanCommand);
    const items = result.Items.map(item => unmarshall(item));
    
    console.log('📊 Total items in DynamoDB:', items.length);

    // If no search query, return ALL images
    if (!q || q.trim() === '') {
      console.log('📂 Returning ALL images');
      const imagesWithUrls = items.map(item => ({
        key: item.imageId,
        caption: item.caption,
        tags: item.tags,
        uploadTime: item.uploadTime,
        presignedGetUrl: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.imageId}`
      }));
      return res.json(imagesWithUrls);
    }

    // Process search query
    const searchTerm = q.toLowerCase().trim();
    console.log('🔍 Searching for term:', searchTerm);
    
    // Filter items based on search term (case-insensitive)
    const filteredItems = items.filter(item => {
      // Search in caption
      const captionMatch = item.caption && item.caption.toLowerCase().includes(searchTerm);
      
      // Search in tags (each tag individually)
      const tagsMatch = item.tags && item.tags.some(tag => 
        tag && tag.toLowerCase().includes(searchTerm)
      );
      
      return captionMatch || tagsMatch;
    });

    console.log('✅ Found', filteredItems.length, 'matching images');

    const imagesWithUrls = filteredItems.map(item => ({
      key: item.imageId,
      caption: item.caption,
      tags: item.tags,
      uploadTime: item.uploadTime,
      presignedGetUrl: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.imageId}`
    }));

    res.json(imagesWithUrls);
    
  } catch (error) {
    console.error('❌ Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ✅ Delete image from S3 and DynamoDB
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { DeleteItemCommand } from '@aws-sdk/client-dynamodb';

app.post('/api/delete-image', [body('key').isString().notEmpty()], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { key } = req.body;

    // Delete from S3
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key
    }));

    // Delete from DynamoDB
    await dynamoDBClient.send(new DeleteItemCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Key: marshall({ imageId: key })
    }));

    res.json({ success: true, message: 'Image deleted' });
  } catch (error) {
    console.error('❌ Delete image error:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// ✅ Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Root route
app.get("/", (req, res) => {
  res.send("🚀 Backend is working!");
});

// ✅ Start server
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

export default app;