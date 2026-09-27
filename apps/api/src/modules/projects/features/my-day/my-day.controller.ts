import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { MyDayHandler } from './my-day.handler.js';

@Controller()
export class MyDayController {
  constructor(private readonly handler: MyDayHandler) {}

  @Implement(contract.projects.myDay)
  myDay() {
    return implement(contract.projects.myDay).handler(({ input }) => this.handler.execute(input));
  }
}
