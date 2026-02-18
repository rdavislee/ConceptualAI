# Get a MongoDB Atlas Connection URL (Free Tier)

This gives you the `MONGODB_URL` value for your generated backend `.env`.

Back to main docs: [ConceptualAI User Documentation](./README.md)

## Official links

- Deploy free cluster: https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/
- Connection string guide: https://www.mongodb.com/docs/guides/atlas/connection-string/

## Steps

1. Create or log in to MongoDB Atlas.
2. Create a free **M0** cluster.
3. Create a database user (username/password).
4. Add your IP address to the Atlas allowlist (or temporary `0.0.0.0/0` only for testing).
5. Click **Connect** on your cluster.
6. Choose **Connect your application**.
7. Copy the connection string.
8. Replace placeholders (`<username>`, `<password>`) with real values.

## Example format

```text
mongodb+srv://myUser:myPassword@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

## Where to put it

In generated backend `.env`:

- `MONGODB_URL=<your_atlas_url>`
- `DB_NAME=<your_database_name>`

Then also set:

- `JWT_SECRET=<long_random_secret>`

## Next steps

- Continue in: [Beginner App-Building Guide](./getting-started-beginner.md)
- If needed: [Troubleshooting](./troubleshooting.md)
