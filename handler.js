// handler.js

const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid'); // Для генерації унікальних ID

// Ця змінна встановлюється плагіном serverless-offline.
const IS_OFFLINE = process.env.IS_OFFLINE;
// Порт DynamoDB Local
const DYNAMODB_LOCAL_PORT = process.env.DYNAMODB_LOCAL_PORT || 8000;
const ORGANIZATION_USER_QUEUE_URL = process.env.ORGANIZATION_USER_QUEUE_URL;


let dynamoDb;
let sqs;

// Якщо ми працюємо офлайн, явно вказуємо ендпоінт та фіктивні облікові дані.
// Це примусить AWS SDK використовувати локальний DynamoDB без валідації реальних credentials.
if (IS_OFFLINE) {
    dynamoDb = new AWS.DynamoDB.DocumentClient({
        region: 'localhost', 
        endpoint: `http://localhost:${DYNAMODB_LOCAL_PORT}`,
        // Явно вказуємо фіктивні облікові дані, щоб AWS SDK не скаржився
        accessKeyId: 'test',
        secretAccessKey: 'test',
    });
    sqs = new AWS.SQS({
        region: 'localhost',
        endpoint: `http://localhost:9324`, // Типовий порт для localstack/elasticmq SQS
        accessKeyId: 'test',
        secretAccessKey: 'test',
    });
} else {
    // Для розгортання в AWS, AWS SDK автоматично підтягне конфігурацію з середовища Lambda
    dynamoDb = new AWS.DynamoDB.DocumentClient();
    sqs = new AWS.SQS();
}

// Назви таблиць з environment variables (або значення за замовчуванням)
const ORGANIZATIONS_TABLE = process.env.ORGANIZATIONS_TABLE || 'Organizations';
const USERS_TABLE = process.env.USERS_TABLE || 'Users';

// Допоміжна функція для створення відповіді API Gateway
const buildResponse = (statusCode, body) => {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    };
};

// 1. Функція для створення організації (POST /organizations)
module.exports.createOrganization = async (event) => {
    console.log('Виклик createOrganization');
    console.log('Отримано подію:', JSON.stringify(event));

    try {
        const data = JSON.parse(event.body);
        const { name, description } = data;

        // Валідація вхідних даних
        if (!name || !description) {
            return buildResponse(400, { message: 'Назва та опис організації є обов\'язковими.' });
        }

        // Перевірка на унікальність назви організації (синхронно, щоб уникнути дублікатів в черзі)
        const scanParams = {
            TableName: ORGANIZATIONS_TABLE,
            FilterExpression: '#name = :name',
            ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: { ':name': name },
        };
        const result = await dynamoDb.scan(scanParams).promise();

        if (result.Items && result.Items.length > 0) {
            return buildResponse(409, { message: 'Організація з такою назвою вже існує.' });
        }

        const orgId = uuidv4(); // Генеруємо унікальний ID для організації

        // Створюємо повідомлення для SQS
        const message = {
            operation: 'createOrganization', // Тип операції для споживача
            data: { orgId, name, description, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        };

        const sqsParams = {
            QueueUrl: ORGANIZATION_USER_QUEUE_URL,
            MessageBody: JSON.stringify(message)
        };

        await sqs.sendMessage(sqsParams).promise();

        console.log('Повідомлення про створення організації відправлено в SQS:', message);
        return buildResponse(202, { message: 'Запит на створення організації прийнято, обробляється асинхронно.', orgId: orgId });

    } catch (error) {
        console.error('Помилка при створенні організації:', error);
        return buildResponse(500, { message: 'Внутрішня помилка сервера.', error: error.message });
    }
};

// 2. Функція для створення/оновлення користувача (POST/PUT /organizations/{orgId}/users)
module.exports.createOrUpdateUser = async (event) => {
    console.log('Виклик createOrUpdateUser');
    console.log('Отримано подію:', JSON.stringify(event));

    try {
        const { orgId } = event.pathParameters;
        const data = JSON.parse(event.body);
        const { userId, name, email } = data;

        // Валідація вхідних даних
        if (!orgId || !name || !email) {
            return buildResponse(400, { message: 'orgId у шляху, ім\'я та email користувача є обов\'язковими.' });
        }

        // Перевіряємо, чи існує організація з таким orgId (синхронно, перед відправкою в SQS)
        const orgGetParams = {
            TableName: ORGANIZATIONS_TABLE,
            Key: { orgId: orgId },
        };
        const orgResult = await dynamoDb.get(orgGetParams).promise();

        if (!orgResult.Item) {
            return buildResponse(404, { message: `Організація з ID '${orgId}' не знайдена.` });
        }

        const newUserId = userId || uuidv4(); // Використовуємо існуючий userId або генеруємо новий

        // Перевірка на унікальність email в межах організації
        // Це робимо синхронно, щоб уникнути створення дублікатів в черзі
        const queryParams = {
            TableName: USERS_TABLE,
            IndexName: 'OrgId-index',
            KeyConditionExpression: 'orgId = :orgId',
            FilterExpression: 'email = :email',
            ExpressionAttributeValues: {
                ':orgId': orgId,
                ':email': email
            },
        };
        const queryResult = await dynamoDb.query(queryParams).promise();

        if (queryResult.Items && queryResult.Items.length > 0) {
            const existingUser = queryResult.Items[0];
            if (event.requestContext.http.method === 'POST' || (event.requestContext.http.method === 'PUT' && existingUser.userId !== newUserId)) {
                 return buildResponse(409, { message: `Користувач з email '${email}' вже зареєстрований в цій організації.` });
            }
        }
        
        // Створюємо повідомлення для SQS
        const message = {
            operation: event.requestContext.http.method === 'POST' ? 'createUser' : 'updateUser',
            data: { orgId, userId: newUserId, name, email, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        };

        const sqsParams = {
            QueueUrl: ORGANIZATION_USER_QUEUE_URL,
            MessageBody: JSON.stringify(message)
        };

        await sqs.sendMessage(sqsParams).promise();

        console.log('Повідомлення про користувача відправлено в SQS:', message);
        return buildResponse(202, { message: `Запит на ${event.requestContext.http.method === 'POST' ? 'створення' : 'оновлення'} користувача прийнято, обробляється асинхронно.`, userId: newUserId });

    } catch (error) {
        console.error('Помилка при створенні/оновленні користувача:', error);
        return buildResponse(500, { message: 'Внутрішня помилка сервера.', error: error.message });
    }
};

// 3. Функція для оновлення організації (PUT /organizations)
module.exports.updateOrganization = async (event) => {
    console.log('Виклик updateOrganization');
    console.log('Отримано подію:', JSON.stringify(event));

    try {
        const data = JSON.parse(event.body);
        const { orgId, name, description } = data;

        // Валідація вхідних даних
        if (!orgId) {
            return buildResponse(400, { message: 'orgId є обов\'язковим для оновлення організації.' });
        }
        if (!name && !description) {
            return buildResponse(400, { message: 'Назва або опис організації є обов\'язковими для оновлення.' });
        }

        // Перевіряємо, чи існує організація з таким orgId (синхронно, перед відправкою в SQS)
        const orgGetParams = {
            TableName: ORGANIZATIONS_TABLE,
            Key: { orgId: orgId },
        };
        const orgResult = await dynamoDb.get(orgGetParams).promise();

        if (!orgResult.Item) {
            return buildResponse(404, { message: `Організація з ID '${orgId}' не знайдена для оновлення.` });
        }

        // Створюємо повідомлення для SQS
        const message = {
            operation: 'updateOrganization', // Тип операції для споживача
            data: { orgId, name, description, updatedAt: new Date().toISOString() }
        };

        const sqsParams = {
            QueueUrl: ORGANIZATION_USER_QUEUE_URL,
            MessageBody: JSON.stringify(message)
        };

        await sqs.sendMessage(sqsParams).promise();

        console.log('Повідомлення про оновлення організації відправлено в SQS:', message);
        return buildResponse(202, { message: 'Запит на оновлення організації прийнято, обробляється асинхронно.', orgId: orgId });

    } catch (error) {
        console.error('Помилка при оновленні організації:', error);
        return buildResponse(500, { message: 'Внутрішня помилка сервера.', error: error.message });
    }
};

// 4. Функція для отримання організації за ID (GET /organizations/{orgId})
module.exports.getOrganization = async (event) => {
  console.log('Виклик getOrganization');
  console.log('Отримано подію:', JSON.stringify(event));

  try {
      const { orgId } = event.pathParameters; // Отримуємо orgId з URL шляху

      if (!orgId) {
          return buildResponse(400, { message: 'orgId є обов\'язковим параметром шляху.' });
      }

      const params = {
          TableName: ORGANIZATIONS_TABLE,
          Key: { orgId: orgId },
      };

      const result = await dynamoDb.get(params).promise();

      if (!result.Item) {
          return buildResponse(404, { message: `Організація з ID '${orgId}' не знайдена.` });
      }

      console.log('Організація успішно отримана:', result.Item);
      return buildResponse(200, { organization: result.Item });

  } catch (error) {
      console.error('Помилка при отриманні організації:', error);
      return buildResponse(500, { message: 'Внутрішня помилка сервера.', error: error.message });
  }
};

// 5. Функція для отримання користувача за ID (GET /organizations/{orgId}/users/{userId})
module.exports.getUser = async (event) => {
  console.log('Виклик getUser');
  console.log('Отримано подію:', JSON.stringify(event));

  try {
      const { orgId, userId } = event.pathParameters; // Отримуємо orgId та userId з URL шляху

      if (!orgId || !userId) {
          return buildResponse(400, { message: 'orgId та userId є обов\'язковими параметрами шляху.' });
      }

      const params = {
          TableName: USERS_TABLE,
          Key: { userId: userId }, // DynamoDB працює з partition key, який є userId
      };

      const result = await dynamoDb.get(params).promise();

      // Перевіряємо, чи користувач існує і чи належить він до вказаної організації
      if (!result.Item || result.Item.orgId !== orgId) {
          return buildResponse(404, { message: `Користувач з ID '${userId}' не знайдений в організації '${orgId}'.` });
      }

      console.log('Користувач успішно отриманий:', result.Item);
      return buildResponse(200, { user: result.Item });

  } catch (error) {
      console.error('Помилка при отриманні користувача:', error);
      return buildResponse(500, { message: 'Внутрішня помилка сервера.', error: error.message });
  }
};

// 6. Функція для отримання ВСІХ організацій (GET /organizations)
module.exports.getAllOrganizations = async (event) => {
  console.log('Виклик getAllOrganizations');
  console.log('Отримано подію:', JSON.stringify(event));

  try {
      const params = {
          TableName: ORGANIZATIONS_TABLE,
      };

      // Використовуємо метод scan для отримання всіх елементів.
      // Увага: scan може бути неефективним для великих таблиць!
      const result = await dynamoDb.scan(params).promise();

      if (!result.Items || result.Items.length === 0) {
          return buildResponse(200, { message: 'Жодної організації не знайдено.', organizations: [] });
      }

      console.log('Усі організації успішно отримані:', result.Items);
      return buildResponse(200, { organizations: result.Items });

  } catch (error) {
      console.error('Помилка при отриманні всіх організацій:', error);
      return buildResponse(500, { message: 'Внутрішня помилка сервера.', error: error.message });
  }
};

// 7. Функція для отримання всіх користувачів в межах однієї організації (GET /organizations/{orgId}/users)
module.exports.getAllUsersByOrganization = async (event) => {
  console.log('Виклик getAllUsersByOrganization');
  console.log('Отримано подію:', JSON.stringify(event));

  try {
      const { orgId } = event.pathParameters; // Отримуємо orgId з URL шляху

      if (!orgId) {
          return buildResponse(400, { message: 'orgId є обов\'язковим параметром шляху.' });
      }

      // Перевіряємо, чи існує організація з таким orgId
      const orgGetParams = {
          TableName: ORGANIZATIONS_TABLE,
          Key: { orgId: orgId },
      };
      const orgResult = await dynamoDb.get(orgGetParams).promise();

      if (!orgResult.Item) {
          return buildResponse(404, { message: `Організація з ID '${orgId}' не знайдена.` });
      }

      // Використовуємо Query на OrgId-index для отримання всіх користувачів за orgId
      const params = {
          TableName: USERS_TABLE,
          IndexName: 'OrgId-index', // Використовуємо наш GSI
          KeyConditionExpression: 'orgId = :orgId',
          ExpressionAttributeValues: {
              ':orgId': orgId,
          },
      };

      const result = await dynamoDb.query(params).promise();

      if (!result.Items || result.Items.length === 0) {
          return buildResponse(200, { message: `Користувачів в організації '${orgId}' не знайдено.`, users: [] });
      }

      console.log(`Усі користувачі організації '${orgId}' успішно отримані:`, result.Items);
      return buildResponse(200, { users: result.Items });

  } catch (error) {
      console.error('Помилка при отриманні користувачів за організацією:', error);
      return buildResponse(500, { message: 'Внутрішня помилка сервера.', error: error.message });
  }
};


// 8. Функція для обробки повідомлень з SQS (Consumer Lambda)
module.exports.processSqsMessages = async (event) => {
    console.log('Виклик processSqsMessages - Отримано повідомлення з SQS');
    console.log('Подія SQS:', JSON.stringify(event, null, 2));

    for (const record of event.Records) {
        try {
            const messageBody = JSON.parse(record.body);
            const { operation, data } = messageBody;

            console.log(`Обробка повідомлення: Операція=${operation}, Дані=`, data);

            let params;
            let result;

            switch (operation) {
                case 'createOrganization':
                    params = {
                        TableName: ORGANIZATIONS_TABLE,
                        Item: {
                            orgId: data.orgId,
                            name: data.name,
                            description: data.description,
                            createdAt: data.createdAt,
                            updatedAt: data.updatedAt,
                        },
                    };
                    await dynamoDb.put(params).promise();
                    console.log('Організація успішно створена з SQS:', data);
                    break;

                case 'updateOrganization':
                    const updateOrgExpressionParts = [];
                    const updateOrgExpressionAttributeValues = {};
                    const updateOrgExpressionAttributeNames = {};

                    if (data.name) {
                        updateOrgExpressionParts.push('#orgName = :orgName');
                        updateOrgExpressionAttributeValues[':orgName'] = data.name;
                        updateOrgExpressionAttributeNames['#orgName'] = 'name';
                    }
                    if (data.description) {
                        updateOrgExpressionParts.push('description = :description');
                        updateOrgExpressionAttributeValues[':description'] = data.description;
                    }

                    updateOrgExpressionParts.push('updatedAt = :updatedAt');
                    updateOrgExpressionAttributeValues[':updatedAt'] = data.updatedAt;

                    params = {
                        TableName: ORGANIZATIONS_TABLE,
                        Key: { orgId: data.orgId },
                        UpdateExpression: `SET ${updateOrgExpressionParts.join(', ')}`,
                        ExpressionAttributeValues: updateOrgExpressionAttributeValues,
                        ...(Object.keys(updateOrgExpressionAttributeNames).length > 0 && { ExpressionAttributeNames: updateOrgExpressionAttributeNames }),
                        ReturnValues: 'UPDATED_NEW',
                    };
                    await dynamoDb.update(params).promise();
                    console.log('Організація успішно оновлена з SQS:', data);
                    break;

                case 'createUser':
                    params = {
                        TableName: USERS_TABLE,
                        Item: {
                            userId: data.userId,
                            orgId: data.orgId,
                            name: data.name,
                            email: data.email,
                            createdAt: data.createdAt,
                            updatedAt: data.updatedAt,
                        },
                    };
                    await dynamoDb.put(params).promise();
                    console.log('Користувач успішно створений з SQS:', data);
                    break;

                case 'updateUser':
                    // Для оновлення користувача ми припускаємо, що userId є в `data`
                    const updateUserExpressionParts = [];
                    const updateUserExpressionAttributeValues = {};
                    const updateUserExpressionAttributeNames = {};

                    if (data.name) {
                        updateUserExpressionParts.push('#userName = :userName');
                        updateUserExpressionAttributeValues[':userName'] = data.name;
                        updateUserExpressionAttributeNames['#userName'] = 'name';
                    }
                    if (data.email) {
                        updateUserExpressionParts.push('email = :email');
                        updateUserExpressionAttributeValues[':email'] = data.email;
                    }

                    updateUserExpressionParts.push('updatedAt = :updatedAt');
                    updateUserExpressionAttributeValues[':updatedAt'] = data.updatedAt;

                    params = {
                        TableName: USERS_TABLE,
                        Key: { userId: data.userId },
                        UpdateExpression: `SET ${updateUserExpressionParts.join(', ')}`,
                        ExpressionAttributeValues: updateUserExpressionAttributeValues,
                        ...(Object.keys(updateUserExpressionAttributeNames).length > 0 && { ExpressionAttributeNames: updateUserExpressionAttributeNames }),
                        ReturnValues: 'UPDATED_NEW',
                    };
                    await dynamoDb.update(params).promise();
                    console.log('Користувач успішно оновлений з SQS:', data);
                    break;

                default:
                    console.warn(`Невідома операція: ${operation}. Пропускаємо повідомлення.`);
            }
        } catch (error) {
            console.error('Помилка при обробці SQS повідомлення:', record.body, error);

            throw error; // Перекидаємо помилку, щоб SQS не видалив повідомлення з черги
        }
    }
    return { statusCode: 200, body: 'SQS повідомлення оброблені успішно.' };
};