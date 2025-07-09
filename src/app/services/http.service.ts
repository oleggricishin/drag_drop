import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';

@Injectable({
  providedIn: 'root',
})
export class HttpService {

  baseUrl: string = 'https://supplysolver.bytebrand.net';

  constructor(private http: HttpClient) {
  }

  private get(url: string) {
    return this.http.get(`${this.baseUrl}/${url}`, {headers: {'Content-Type': 'application/json'}});
  }

  public getDemands() {
    return this.get(`hotCrud/getCollection/getDemands/PlanningSet/671`);
  }

}
