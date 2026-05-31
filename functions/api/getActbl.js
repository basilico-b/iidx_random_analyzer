export const getActbl = async () => {
  const response = await fetch(
    "https://textage.cc/score/actbl.js"
  );

  return new Response(
    response.body,
    {
      headers: {
        "Content-Type":
          "application/javascript"
      }
    }
  );
}

export const onRequest = getActbl;
