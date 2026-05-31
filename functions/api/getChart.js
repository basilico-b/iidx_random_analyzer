export const getChart = async (context) => {
  try {
    const url = new URL(context.request.url).searchParams.get('url');
    console.log("url: ", url);
    if(!url){
      return new Response(JSON.stringify({error:'url parameter is required'}), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    const apiUrl = `https://www.iidx-memo.com/api/textage2json?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Referer': 'https://www.iidx-memo.com/'
      }
    });

    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      headers
    });
  } catch (err) {
    return new Response(JSON.stringify({error:'internal server error', message:String(err)}), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};

export const onRequest = getChart;
