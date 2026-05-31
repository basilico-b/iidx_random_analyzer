export const getTitletbl = async () => {
  const response = await fetch(
    "https://textage.cc/score/titletbl.js"
  );

  const headers = new Headers(
    response.headers
  );

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      headers
    }
  );
}

export const onRequest = getTitletbl;
