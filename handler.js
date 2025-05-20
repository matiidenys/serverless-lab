// handler.js

const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid'); // Для генерації унікальних ID

// Ця змінна встановлюється плагіном serverless-offline.
const IS_OFFLINE = process.env.IS_OFFLINE;
// Порт DynamoDB Local
const DYNAMODB_LOCAL_PORT = process.env.DYNAMODB_LOCAL_PORT || 8000;


let dynamoDb;

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
} else {
    // Для розгортання в AWS, AWS SDK автоматично підтягне конфігурацію з середовища Lambda
    dynamoDb = new AWS.DynamoDB.DocumentClient();
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

        // Перевірка на унікальність назви організації
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
        const newOrganization = {
            orgId: orgId,
            name: name,
            description: description,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const params = {
            TableName: ORGANIZATIONS_TABLE,
            Item: newOrganization,
        };

        await dynamoDb.put(params).promise();
        console.log('Організація успішно створена:', newOrganization);

        return buildResponse(201, { message: 'Організація успішно створена.', organization: newOrganization });

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
      const { orgId } = event.pathParameters; // Отримуємо orgId з URL шляху
      const data = JSON.parse(event.body);
      const { name, email, userId } = data; // userId може бути в тілі для PUT-запиту

      // Валідація вхідних даних
      if (!orgId || !name || !email) {
          return buildResponse(400, { message: 'orgId у шляху, ім\'я та email користувача є обов\'язковими.' });
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

      // Логіка для PUT-запиту (оновлення користувача)
      if (event.requestContext.http.method === 'PUT') {
          if (!userId) {
              return buildResponse(400, { message: 'Для оновлення користувача userId є обов\'язковим у тілі запиту.' });
          }

          // Перевіряємо, чи існує користувач з таким userId в даній організації
          const userGetParams = {
              TableName: USERS_TABLE,
              Key: { userId: userId },
          };
          const existingUserResult = await dynamoDb.get(userGetParams).promise();

          if (!existingUserResult.Item || existingUserResult.Item.orgId !== orgId) {
              return buildResponse(404, { message: `Користувач з ID '${userId}' не знайдений в організації '${orgId}'.` });
          }

          // Оновлюємо дані користувача
          const updateUserParams = {
              TableName: USERS_TABLE,
              Key: { userId: userId },
              UpdateExpression: 'SET #name = :name, email = :email, updatedAt = :updatedAt',
              ExpressionAttributeNames: { '#name': 'name' },
              ExpressionAttributeValues: {
                  ':name': name,
                  ':email': email,
                  ':updatedAt': new Date().toISOString(),
              },
              ReturnValues: 'ALL_NEW', // Повертаємо оновлений об'єкт
          };
          const updatedUser = await dynamoDb.update(updateUserParams).promise();

          console.log('Користувач успішно оновлений:', updatedUser.Attributes);
          return buildResponse(200, { message: 'Користувач успішно оновлений.', user: updatedUser.Attributes });

      } else { // Логіка для POST-запиту (створення нового користувача)
          // Перевіряємо унікальність email в рамках даної організації
          // Для цього використовуємо Global Secondary Index (GSI) OrgId-index
          const queryParams = {
              TableName: USERS_TABLE,
              IndexName: 'OrgId-index', // Назва нашого GSI з serverless.yml
              KeyConditionExpression: 'orgId = :orgId',
              FilterExpression: 'email = :email', // Фільтруємо за email в межах orgId
              ExpressionAttributeValues: {
                  ':orgId': orgId,
                  ':email': email,
              },
          };
          const existingUsersWithEmail = await dynamoDb.query(queryParams).promise();

          if (existingUsersWithEmail.Items && existingUsersWithEmail.Items.length > 0) {
              return buildResponse(409, { message: 'Користувач з таким email вже зареєстрований в цій організації.' });
          }

          const newUserId = uuidv4(); // Генеруємо унікальний ID для нового користувача
          const newUser = {
              userId: newUserId,
              orgId: orgId, // Зв'язуємо користувача з організацією
              name: name,
              email: email,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
          };

          const putUserParams = {
              TableName: USERS_TABLE,
              Item: newUser,
          };

          await dynamoDb.put(putUserParams).promise();
          console.log('Користувач успішно зареєстрований:', newUser);

          return buildResponse(201, { message: 'Користувач успішно зареєстрований.', user: newUser });
      }

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
      const { orgId, name, description } = data; // orgId, name, description очікуються в тілі запиту

      // Валідація вхідних даних
      if (!orgId) {
          return buildResponse(400, { message: 'orgId є обов\'язковим для оновлення організації.' });
      }
      if (!name && !description) {
          return buildResponse(400, { message: 'Назва або опис організації є обов\'язковими для оновлення.' });
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

      // Побудова UpdateExpression та ExpressionAttributeValues
      const updateExpressionParts = [];
      const expressionAttributeValues = {};
      const expressionAttributeNames = {}; // Додаємо ExpressionAttributeNames для зарезервованих слів

      if (name) {
          updateExpressionParts.push('#name = :name');
          expressionAttributeValues[':name'] = name;
          expressionAttributeNames['#name'] = 'name'; // 'name' є зарезервованим словом у DynamoDB
      }
      if (description) {
          updateExpressionParts.push('description = :description');
          expressionAttributeValues[':description'] = description;
      }

      // Додаємо оновлення updatedAt
      updateExpressionParts.push('updatedAt = :updatedAt');
      expressionAttributeValues[':updatedAt'] = new Date().toISOString();

      const updateParams = {
          TableName: ORGANIZATIONS_TABLE,
          Key: { orgId: orgId },
          UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
          ExpressionAttributeValues: expressionAttributeValues,
          ...(Object.keys(expressionAttributeNames).length > 0 && { ExpressionAttributeNames: expressionAttributeNames }),
          ReturnValues: 'ALL_NEW', // Повертаємо оновлений об'єкт
      };

      const updatedOrganization = await dynamoDb.update(updateParams).promise();

      console.log('Організація успішно оновлена:', updatedOrganization.Attributes);
      return buildResponse(200, { message: 'Організація успішно оновлена.', organization: updatedOrganization.Attributes });

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
