import math
import requests as rq
import pandas as pd
import random

from datetime import datetime

# ==============================================================================
#   Class StockChartsData
#
#   Example Use: 
#       scd = StockChartsData()
#       df = scd.get("$NYMO", years = 1)    
# ==============================================================================
class StockChartsData:
    def __init__(self):
        self.USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'

    def get(self, ticker: str, years: int = 5): 

        length = 10
        RANDOM_I = ''.join([str(random.randint(0,9)) for _ in range(length)])
        URL = f'https://stockcharts.com/c-sc/sc?s={ticker}&p=D&yr={years}&i=t{RANDOM_I}c&img=text&inspector=yes'
        
        data = rq.get(URL, headers={'user-agent': self.USER_AGENT}).text

        data = data.split('<pricedata>')[1].replace('</pricedata>', '')

        lines = data.split('|')
        data = []
        for line in lines:
            cols = line.split(' ')
            print(cols)

            date = datetime(int(cols[1][0:4]), int(cols[1][4:6]), int(cols[1][6:8]))
            value = float(cols[-2])

            if not math.isnan(value):
                data.append({'date': date.strftime("%Y-%m-%d"), ticker.lstrip('$'): value})

        df = pd.DataFrame.from_dict(data).set_index('date')

        return df
